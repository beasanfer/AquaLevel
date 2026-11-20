const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* CONFIGURAÇÃO E PERSISTÊNCIA
 * estado.json armazena estado, medições, acionamentos e alertas.
 * Sua durabilidade depende do armazenamento do ambiente de execução;
 * discos efêmeros podem perder esse arquivo após reinicializações. */
// Arquivo de persistência: guarda o estado do sistema E os históricos
// (leituras, acionamentos da bomba, alertas). Sobrevive a reinícios do
// processo dentro do mesmo container/disco. Em PaaS com filesystem
// efêmero (ex.: Render Free tier), o arquivo é perdido em cada deploy
// ou wake-up — comportamento aceito neste projeto.
const ARQUIVO_ESTADO = path.join(__dirname, "estado.json");

// Limita a quantidade de registros em memória e em estado.json.
const MAX_HISTORICO_MEMORIA = 5000; // cerca de 83 min com 1 leitura/s
const HISTORICO_RESPOSTA = 1000; // janela mais recente exibida na UI
const MAX_HISTORICO_BOMBA_MEMORIA = 500; // transições da bomba
const MAX_ALERTAS_MEMORIA = 200;

// Watchdog: considera o ESP32 silencioso após 15 s sem POST.
const TIMEOUT_ESP32_MS = 15000;
const INTERVALO_WATCHDOG_MS = 5000;

// Limite de segurança do backend, igual ao NIVEL_CORTE_SEGURANCA
// definido no firmware.
const LIMITE_SEGURANCA_MANUAL = 98;

app.use(express.json());

// Serve arquivos da pasta public/ independentemente do diretório de execução.
app.use(express.static(path.join(__dirname, "public")));

// Expõe a distribuição local do Chart.js sem depender de uma CDN.
// Requer a dependência instalada em node_modules.
app.use(
  "/vendor/chartjs",
  express.static(path.join(__dirname, "node_modules", "chart.js", "dist")),
);

/* UTILITÁRIOS */
// Descarta os registros mais antigos quando o limite é excedido.
function limitarTamanho(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/* ESTADO INICIAL E VARIÁVEIS COMPARTILHADAS */
const estadoPadraoSistema = {
  nivel: 0,
  litros: 0,
  alturaCm: 0,
  capacidadeLitros: 0,
  bombaLigada: false,
  modo: "automatico",
  minimo: 30,
  maximo: 90,
  sensorOK: true,
  ultimaLeituraDataHora: null,
};

// Coleções inicializadas vazias e restauradas do arquivo, se existir.
let sistema = { ...estadoPadraoSistema };
let historico = [];
let historicoBomba = [];
let alertas = []; // histórico de ocorrências registradas
let alertasAtivos = []; // condições não resolvidas
let nivelCriticoAtivo = false;

// Referência temporal do watchdog, iniciada na subida do servidor.
let ultimaLeituraRecebida = Date.now();

// Na primeira leitura após entrar em modo manual, o eco do ESP32 só
// prevalece se o usuário ainda não enviou um comando de bomba.
let modoRecemAlterado = false;
let comandoManualDesdeTroca = false;

/* RESTAURAÇÃO DO ESTADO
 * Suporta estado.json no formato atual, com a propriedade `sistema`, e
 * arquivos legados em que o objeto inteiro representa o estado.
 * A bomba volta a false no estado lógico do servidor. Se estava true
 * no arquivo, um evento sintético registra esse reset lógico; ele não
 * confirma a posição física do relé controlado pelo ESP32. */
function carregarEstado() {
  try {
    if (!fs.existsSync(ARQUIVO_ESTADO)) {
      return;
    }

    const bruto = fs.readFileSync(ARQUIVO_ESTADO, "utf8");
    const salvo = JSON.parse(bruto);

    const novoSistema = salvo.sistema !== undefined ? salvo.sistema : salvo;
    sistema = { ...estadoPadraoSistema, ...novoSistema };

    /* Normaliza dados persistidos de versões antigas: máximo até 97% e
     * mínimo estritamente inferior ao máximo após o ajuste. */
    if (sistema.maximo > LIMITE_SEGURANCA_MANUAL - 1) {
      console.warn(
        `maximo=${sistema.maximo} excede o limite de segurança; ` +
          `ajustando para ${LIMITE_SEGURANCA_MANUAL - 1}.`,
      );
      sistema.maximo = LIMITE_SEGURANCA_MANUAL - 1;
      if (sistema.minimo >= sistema.maximo) {
        sistema.minimo = Math.max(0, sistema.maximo - 1);
      }
    }

    /* Preserva o estado restaurado para decidir sobre o evento sintético. */
    const bombaEstavaLigada = sistema.bombaLigada === true;
    sistema.bombaLigada = false;

    if (Array.isArray(salvo.historico)) {
      historico = salvo.historico;
      limitarTamanho(historico, MAX_HISTORICO_MEMORIA);
    }
    if (Array.isArray(salvo.historicoBomba)) {
      historicoBomba = salvo.historicoBomba;
      limitarTamanho(historicoBomba, MAX_HISTORICO_BOMBA_MEMORIA);
    }
    if (Array.isArray(salvo.alertas)) {
      alertas = salvo.alertas;
      limitarTamanho(alertas, MAX_ALERTAS_MEMORIA);
    }
    if (Array.isArray(salvo.alertasAtivos)) {
      alertasAtivos = salvo.alertasAtivos;
      limitarTamanho(alertasAtivos, MAX_ALERTAS_MEMORIA);
    }
    nivelCriticoAtivo = alertasAtivos.some((a) => a.tipo === "nivel_critico");

    /* Registra no histórico o desligamento lógico decorrente da restauração.
     * O horário corresponde ao boot do backend, não a uma confirmação
     * de que o relé físico foi desligado nesse instante. */
    if (bombaEstavaLigada) {
      historicoBomba.push({
        estado: "desligada",
        modo: sistema.modo,
        dataHora: new Date().toISOString(),
      });
      limitarTamanho(historicoBomba, MAX_HISTORICO_BOMBA_MEMORIA);
    }

    console.log(
      `Estado restaurado de ${ARQUIVO_ESTADO} ` +
        `(${historico.length} leituras, ${historicoBomba.length} acionamentos, ` +
        `${alertas.length} alertas).`,
    );
  } catch (e) {
    console.error("Falha ao carregar estado:", e.message);
  }
}

/* GRAVAÇÃO DO ESTADO
 * Salva em estado.json.tmp e depois renomeia no mesmo filesystem.
 * O JSON compacto reduz I/O, mas a escrita síncrona bloqueia o event
 * loop durante a operação. Um arquivo .tmp pode sobrar após uma falha. */
function salvarEstadoAgora() {
  try {
    const dados = {
      sistema,
      historico,
      historicoBomba,
      alertas,
      alertasAtivos,
    };
    const caminhoTmp = ARQUIVO_ESTADO + ".tmp";
    fs.writeFileSync(caminhoTmp, JSON.stringify(dados));
    fs.renameSync(caminhoTmp, ARQUIVO_ESTADO);
  } catch (e) {
    console.error("Falha ao salvar estado:", e.message);
  }
}

carregarEstado();

/* Persiste imediatamente dados migrados, limites normalizados e
 * eventuais eventos sintéticos de desligamento. */
salvarEstadoAgora();

/* ALTERAÇÕES DE ESTADO E ALERTAS */
// Registra e persiste apenas transições efetivas do estado da bomba.
function registrarAcionamento(novoEstado) {
  if (sistema.bombaLigada !== novoEstado) {
    sistema.bombaLigada = novoEstado;
    historicoBomba.push({
      estado: novoEstado ? "ligada" : "desligada",
      modo: sistema.modo,
      dataHora: new Date().toISOString(),
    });
    limitarTamanho(historicoBomba, MAX_HISTORICO_BOMBA_MEMORIA);
    salvarEstadoAgora();
  }
}

function registrarAlerta(tipo, mensagem, nivel = null, ativo = false) {
  // Evita duplicar ocorrências enquanto o mesmo alerta está ativo.
  if (ativo && alertasAtivos.some((a) => a.tipo === tipo)) return;

  const alerta = {
    tipo,
    mensagem,
    dataHora: new Date().toISOString(),
  };
  if (nivel !== null) alerta.nivel = nivel;
  alertas.push(alerta);
  limitarTamanho(alertas, MAX_ALERTAS_MEMORIA);

  // Separa o histórico de ocorrências das condições ainda não resolvidas.
  if (ativo && !alertasAtivos.some((a) => a.tipo === tipo)) {
    alertasAtivos.push({ ...alerta });
    limitarTamanho(alertasAtivos, MAX_ALERTAS_MEMORIA);
  }
  salvarEstadoAgora();
}

function resolverAlerta(tipo) {
  const tamanhoAnterior = alertasAtivos.length;
  alertasAtivos = alertasAtivos.filter((a) => a.tipo !== tipo);
  if (alertasAtivos.length !== tamanhoAnterior) salvarEstadoAgora();
}

// O nível só é crítico abaixo do mínimo; ao voltar à faixa normal,
// o alerta ativo é resolvido. O comparador < coincide com firmware e UI.
function verificarNivelCritico() {
  if (sistema.nivel < sistema.minimo) {
    if (!nivelCriticoAtivo) {
      registrarAlerta(
        "nivel_critico",
        "Nível de água crítico.",
        sistema.nivel,
        true,
      );
      nivelCriticoAtivo = true;
    }
  } else {
    nivelCriticoAtivo = false;
    resolverAlerta("nivel_critico");
  }
}

/* API DE TELEMETRIA E COMANDOS
 * Um POST /api/nivel recebe a leitura e devolve o modo, os limites e o
 * estado de comando. A UI pode antecipar visualmente uma mudança antes
 * de o ESP32 receber e executar a resposta. */
app.post("/api/nivel", (req, res) => {
  // Reinicia o watchdog quando chega um POST à rota de telemetria.
  ultimaLeituraRecebida = Date.now();

  const nivelBruto = req.body.nivel;
  const litrosBruto = req.body.litros;

  // A convenção nivel=-1 informa falha no sensor; o backend registra
  // o alerta e desliga o estado lógico da bomba.
  if (nivelBruto !== undefined && Number(nivelBruto) === -1) {
    sistema.sensorOK = false;
    registrarAlerta("sensor_falha", "Falha na leitura do sensor.", null, true);

    // Mantém o estado lógico da bomba desligado em caso de falha.
    registrarAcionamento(false);

    // Cancela a sincronização pendente do modo manual.
    modoRecemAlterado = false;
    comandoManualDesdeTroca = false;

    return res.status(200).json({
      sucesso: false,
      sensorOK: false,
      erro: "Falha na leitura do sensor.",
      modo: sistema.modo,
      minimo: sistema.minimo,
      maximo: sistema.maximo,
      bombaLigada: sistema.bombaLigada,
    });
  }

  const nivel = Number(nivelBruto);
  const litros = Number(litrosBruto);

  // Valida presença, finitude e faixa de nível e volume; rejeita com 400.
  if (
    nivelBruto === undefined ||
    nivelBruto === null ||
    nivelBruto === "" ||
    !Number.isFinite(nivel) ||
    nivel < 0 ||
    nivel > 100 ||
    litrosBruto === undefined ||
    litrosBruto === null ||
    litrosBruto === "" ||
    !Number.isFinite(litros) ||
    litros < 0
  ) {
    sistema.sensorOK = false;
    registrarAlerta(
      "sensor_falha",
      "Payload inválido recebido do sensor.",
      null,
      true,
    );
    registrarAcionamento(false);
    modoRecemAlterado = false;
    comandoManualDesdeTroca = false;

    return res.status(400).json({
      sucesso: false,
      erro: "Leitura inválida do sensor.",
      modo: sistema.modo,
      minimo: sistema.minimo,
      maximo: sistema.maximo,
      bombaLigada: sistema.bombaLigada,
    });
  }

  sistema.sensorOK = true;
  resolverAlerta("sensor_falha");
  resolverAlerta("esp32_offline");
  sistema.ultimaLeituraDataHora = new Date().toISOString();
  sistema.nivel = nivel;
  sistema.litros = litros;

  // Altura e capacidade são campos opcionais: se ausentes, mantém os
  // valores anteriores. O firmware deste relatório não os envia no POST.
  const alturaBruta = Number(req.body.alturaCm);
  if (Number.isFinite(alturaBruta) && alturaBruta >= 0) {
    sistema.alturaCm = alturaBruta;
  }
  const capacidadeBruta = Number(req.body.capacidadeLitros);
  if (Number.isFinite(capacidadeBruta) && capacidadeBruta > 0) {
    sistema.capacidadeLitros = capacidadeBruta;
  }

  // Desliga o estado lógico da bomba em modo manual ao alcançar 98%.
  // Fecha a janela de sincronização para ignorar o eco possivelmente
  // desatualizado; o firmware também aplica o corte local.
  if (
    sistema.modo === "manual" &&
    sistema.bombaLigada &&
    sistema.nivel >= LIMITE_SEGURANCA_MANUAL
  ) {
    registrarAcionamento(false);
    registrarAlerta(
      "corte_seguranca",
      `Bomba desligada automaticamente por segurança (nível ≥ ${LIMITE_SEGURANCA_MANUAL}%).`,
      sistema.nivel,
    );
    modoRecemAlterado = false;
    comandoManualDesdeTroca = true;
  }

  // Origem do estado da bomba: no automático, o ESP32 prevalece.
  // No manual, o eco é aceito apenas na primeira leitura após a troca
  // de modo, desde que não exista comando do usuário mais recente.
  if (typeof req.body.bombaLigada === "boolean") {
    if (sistema.modo === "automatico") {
      registrarAcionamento(req.body.bombaLigada);
    } else if (modoRecemAlterado && !comandoManualDesdeTroca) {
      registrarAcionamento(req.body.bombaLigada);
    }
  }

  // Consome a janela de sincronização após esta leitura.
  modoRecemAlterado = false;
  comandoManualDesdeTroca = false;

  // Guarda cada medição em memória. A gravação em disco acontece
  // periodicamente ou quando há outras mudanças persistidas.
  historico.push({
    nivel: sistema.nivel,
    litros: sistema.litros,
    bombaLigada: sistema.bombaLigada,
    modo: sistema.modo,
    dataHora: new Date().toISOString(),
  });
  limitarTamanho(historico, MAX_HISTORICO_MEMORIA);

  verificarNivelCritico();

  // Retorna os comandos na resposta ao próprio POST de telemetria.
  res.json({
    sucesso: true,
    modo: sistema.modo,
    minimo: sistema.minimo,
    maximo: sistema.maximo,
    bombaLigada: sistema.bombaLigada,
  });
});

/* API DE CONSULTA E COMANDOS */
// Consulta de comando sem alterações de estado.
app.get("/api/comando", (req, res) => {
  res.json({
    bombaLigada: sistema.bombaLigada,
    modo: sistema.modo,
    minimo: sistema.minimo,
    maximo: sistema.maximo,
  });
});

app.get("/api/status", (req, res) => {
  res.json(sistema);
});

// Expõe apenas as últimas HISTORICO_RESPOSTA medições.
app.get("/api/historico", (req, res) => {
  res.json(historico.slice(-HISTORICO_RESPOSTA));
});

app.get("/api/historico-bomba", (req, res) => {
  res.json(historicoBomba);
});

app.get("/api/alertas", (req, res) => {
  res.json(alertas); // ocorrências retidas em memória
});

app.get("/api/alertas/ativos", (req, res) => {
  res.json(alertasAtivos); // condições não resolvidas
});

/* ESTATÍSTICAS DO HISTÓRICO RETIDO EM MEMÓRIA
 * Campos numéricos nulos indicam ausência de amostras válidas.
 * O consumo é uma estimativa obtida somando quedas de volume. */
// Calculadas sob demanda sobre o histórico em memória (até 5000 amostras
// ≈ 1h20). Quando não há amostras, os campos numéricos vêm como null para
// que a UI exiba "--" em vez de 0 (0% seria um valor falso).
app.get("/api/estatisticas", (req, res) => {
  const amostrasValidas = historico.filter((h) => {
    const n = Number(h.nivel);
    const l = Number(h.litros);
    return (
      Number.isFinite(n) && n >= 0 && n <= 100 && Number.isFinite(l) && l >= 0
    );
  });

  if (amostrasValidas.length === 0) {
    return res.json({
      nivelMedio: null,
      nivelMaximo: null,
      nivelMinimo: null,
      consumoEstimado: null,
      acionamentos: historicoBomba.filter((e) => e.estado === "ligada").length,
      amostras: 0,
    });
  }

  const niveis = amostrasValidas.map((h) => Number(h.nivel));
  const somaNivel = niveis.reduce((soma, n) => soma + n, 0);
  const nivelMedio = somaNivel / amostrasValidas.length;
  const nivelMax = Math.max(...niveis);
  const nivelMin = Math.min(...niveis);

  // Soma reduções de litros entre pares consecutivos da sequência
  // filtrada de leituras válidas; aumentos não entram no consumo.
  let consumo = 0;
  for (let i = 1; i < amostrasValidas.length; i++) {
    const prev = Number(amostrasValidas[i - 1].litros);
    const curr = Number(amostrasValidas[i].litros);
    if (prev > curr) consumo += prev - curr;
  }

  const acionamentos = historicoBomba.filter(
    (e) => e.estado === "ligada",
  ).length;

  res.json({
    nivelMedio: Number(nivelMedio.toFixed(1)),
    nivelMaximo: Number(nivelMax.toFixed(1)),
    nivelMinimo: Number(nivelMin.toFixed(1)),
    consumoEstimado: Math.round(consumo),
    acionamentos,
    amostras: amostrasValidas.length,
  });
});

app.post("/api/bomba", (req, res) => {
  if (sistema.modo !== "manual") {
    return res.status(400).json({
      erro: "Controle manual indisponível.",
    });
  }

  if (typeof req.body.ligar !== "boolean") {
    return res.status(400).json({
      erro: "Estado da bomba inválido.",
    });
  }

  // Bloqueia o comando manual de ligar quando o nível atingiu o
  // limite de segurança, independentemente do máximo configurado.
  if (req.body.ligar && sistema.nivel >= LIMITE_SEGURANCA_MANUAL) {
    return res.status(400).json({
      erro: `Bomba não pode ser ligada. Limite de segurança atingido (≥ ${LIMITE_SEGURANCA_MANUAL}%).`,
    });
  }

  if (req.body.ligar && sistema.nivel >= sistema.maximo) {
    return res.status(400).json({
      erro: "Limite máximo atingido.",
    });
  }

  registrarAcionamento(req.body.ligar);

  // Prioriza o comando do usuário sobre o eco de sincronização.
  comandoManualDesdeTroca = true;

  res.json(sistema);
});

app.post("/api/modo", (req, res) => {
  const modo = req.body.modo;

  if (modo !== "manual" && modo !== "automatico") {
    return res.status(400).json({
      erro: "Modo inválido.",
    });
  }

  sistema.modo = modo;
  salvarEstadoAgora();

  // Abre uma janela de uma leitura ao entrar no modo manual.
  if (modo === "manual") {
    modoRecemAlterado = true;
    comandoManualDesdeTroca = false;
  } else {
    modoRecemAlterado = false;
    comandoManualDesdeTroca = false;
  }

  res.json(sistema);
});

app.post("/api/limites", (req, res) => {
  const minimo = Number(req.body.minimo);
  const maximo = Number(req.body.maximo);

  // Exige números finitos, mínimo não negativo e mínimo < máximo.
  if (
    !Number.isFinite(minimo) ||
    !Number.isFinite(maximo) ||
    minimo < 0 ||
    minimo >= maximo
  ) {
    return res.status(400).json({
      erro: "Limites inválidos.",
    });
  }

  // O máximo configurável é 97%, preservando uma margem até o corte
  // local em 98% definido no firmware.
  if (maximo > LIMITE_SEGURANCA_MANUAL - 1) {
    return res.status(400).json({
      erro: `Nível máximo não pode exceder ${LIMITE_SEGURANCA_MANUAL - 1}% (limite de segurança do firmware é ${LIMITE_SEGURANCA_MANUAL}%).`,
    });
  }

  sistema.minimo = minimo;
  sistema.maximo = maximo;
  salvarEstadoAgora();

  verificarNivelCritico();

  res.json(sistema);
});

/* WATCHDOG DE COMUNICAÇÃO E SALVAMENTO PROGRAMADO */
// Sem POST durante TIMEOUT_ESP32_MS, sinaliza sensor indisponível
// e registra alerta de ESP32 offline.
setInterval(() => {
  const silencioMs = Date.now() - ultimaLeituraRecebida;
  if (silencioMs <= TIMEOUT_ESP32_MS) return;
  if (sistema.sensorOK === false) return; // já sinalizado, evita registros repetidos

  console.log(
    `ESP32 silencioso por ${Math.round(silencioMs / 1000)}s — marcando offline.`,
  );
  sistema.sensorOK = false;
  registrarAlerta(
    "esp32_offline",
    `ESP32 sem comunicação há mais de ${Math.round(
      TIMEOUT_ESP32_MS / 1000,
    )} segundos.`,
    null,
    true,
  );

  // Em modo manual, também registra a bomba como desligada no backend.
  // Sem comunicação, não há confirmação imediata do relé físico.
  if (sistema.modo === "manual" && sistema.bombaLigada) {
    registrarAcionamento(false);
  }
}, INTERVALO_WATCHDOG_MS);

// Salva as leituras acumuladas a cada 60 s e durante o encerramento.
setInterval(salvarEstadoAgora, 60000);

process.on("SIGINT", () => {
  salvarEstadoAgora();
  process.exit(0);
});
process.on("SIGTERM", () => {
  salvarEstadoAgora();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`AquaLevel rodando em http://localhost:${PORT}`);
  console.log(`Estado persistido em ${ARQUIVO_ESTADO}`);
  console.log(
    `Watchdog ESP32: ${TIMEOUT_ESP32_MS / 1000}s | Histórico em memória: ${MAX_HISTORICO_MEMORIA} | Servido: ${HISTORICO_RESPOSTA}`,
  );
});
