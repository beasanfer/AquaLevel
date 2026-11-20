const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* ==================== CONFIGURAÇÃO ==================== */
// Arquivo de persistência: guarda o estado do sistema E os históricos
// (leituras, acionamentos da bomba, alertas). Sobrevive a reinícios do
// processo dentro do mesmo container/disco. Em PaaS com filesystem
// efêmero (ex.: Render Free tier), o arquivo é perdido em cada deploy
// ou wake-up — comportamento aceito neste projeto.
const ARQUIVO_ESTADO = path.join(__dirname, "estado.json");

// Limites para evitar crescimento infinito dos arrays em memória
// (e, por consequência, do estado.json)
const MAX_HISTORICO_MEMORIA = 5000; // ~1h20 de leituras (1/s)
const HISTORICO_RESPOSTA = 1000; // últimos 1000 servidos à UI
const MAX_HISTORICO_BOMBA_MEMORIA = 500; // acionamentos são esparsos
const MAX_ALERTAS_MEMORIA = 200;

// Watchdog de comunicação com o ESP32
const TIMEOUT_ESP32_MS = 15000;
const INTERVALO_WATCHDOG_MS = 5000;

// Corte de segurança em modo manual (deve coincidir com
// NIVEL_CORTE_SEGURANCA do firmware)
const LIMITE_SEGURANCA_MANUAL = 98;

app.use(express.json());

// Caminho do estático resolvido em relação a __dirname (não ao CWD),
// permitindo `node server.js` de qualquer diretório.
app.use(express.static(path.join(__dirname, "public")));

// Chart.js servido diretamente de node_modules — evita CDN (funciona
// offline e acompanha o versionamento via npm). O arquivo esperado é
// chart.umd.min.js (Chart.js v4+). Confirme com:
//   ls node_modules/chart.js/dist
app.use(
  "/vendor/chartjs",
  express.static(path.join(__dirname, "node_modules", "chart.js", "dist")),
);

/* ==================== HELPERS ==================== */
// Mantém o array com no máximo `max` elementos, descartando os mais antigos.
// Declarado antes de carregarEstado() para deixar explícita a dependência
// (embora function declarations sejam hoisted, a ordem aqui ajuda a ler).
function limitarTamanho(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/* ==================== ESTADO ==================== */
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

// Variáveis globais preenchidas por carregarEstado()
let sistema = { ...estadoPadraoSistema };
let historico = [];
let historicoBomba = [];
let alertas = []; // histórico imutável de ocorrências
let alertasAtivos = []; // condições que ainda exigem atenção
let nivelCriticoAtivo = false;

// Timestamp da última leitura recebida do ESP32. Inicializado no boot —
// se o ESP32 não falar em TIMEOUT_ESP32_MS, consideramos offline.
let ultimaLeituraRecebida = Date.now();

// Controle da janela de troca de modo:
// - modoRecemAlterado: true entre /api/modo(manual) e a próxima leitura.
// - comandoManualDesdeTroca: true se o usuário já deu comando de bomba
//   nessa janela — nesse caso, o comando do usuário vence o eco do ESP32.
let modoRecemAlterado = false;
let comandoManualDesdeTroca = false;

/* Carrega estado + históricos do disco.
 *
 * Formato novo (após esta versão):
 *   {
 *     "sistema": {...},
 *     "historico": [...],
 *     "historicoBomba": [...],
 *     "alertas": [...],
 *     "alertasAtivos": [...]
 *   }
 *
 * Formato antigo (compatibilidade):
 *   {
 *     "nivel": 45.3, "litros": 453, ...
 *   }
 *   — detectado pela ausência de `sistema`; nesse caso, o objeto
 *   inteiro é tratado como o próprio `sistema` (históricos começam
 *   vazios, pois não existiam antes desta versão).
 *
 * Após o boot, `sistema.bombaLigada` é SEMPRE forçado a `false` (por
 * segurança), mas o histórico preservado guardava a última transição
 * real. Sem uma compensação, o card BOMBA mostraria "Desligada"
 * enquanto o widget "Últimos eventos" mostraria "Bomba ligada" — UI
 * contraditória. Por isso, quando a bomba estava ligada antes do
 * restart, registramos um evento sintético de "desligada" logo após
 * carregar, para refletir o corte implícito do restart.
 */
function carregarEstado() {
  try {
    if (!fs.existsSync(ARQUIVO_ESTADO)) {
      return;
    }

    const bruto = fs.readFileSync(ARQUIVO_ESTADO, "utf8");
    const salvo = JSON.parse(bruto);

    const novoSistema = salvo.sistema !== undefined ? salvo.sistema : salvo;
    sistema = { ...estadoPadraoSistema, ...novoSistema };

    /* Defensivo: garante que maximo nunca exceda o limite de segurança
       universal (97). Versões antigas do servidor não validavam maximo
       em /api/limites, então um estado.json legado podia conter 98/99/100.
       Sem este clamp, o slider (max="97") exibiria 97 enquanto o <h2>
       mostraria 100 — inconsistência visível. Também ajusta minimo caso
       a coerção de maximo o torne inválido (minimo >= maximo). */
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

    /* Captura o estado ANTES de forçar false, para saber se precisamos
       registrar o desligamento implícito do restart. */
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

    /* Coerência: o card BOMBA mostra "Desligada" após o boot; o
       histórico precisa refletir isso, senão a UI fica contraditória.
       O evento é datado no momento do boot (não no crash) porque
       tecnicamente foi o boot que fechou o relé — o operador verá o
       desligamento na hora em que o servidor voltou. */
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

/* Grava estado + históricos no disco, de forma atômica.
 *
 * Estratégia: writeFileSync num arquivo .tmp + renameSync. O rename é
 * atômico no mesmo filesystem (POSIX e NTFS), então um crash no meio
 * da escrita deixa ou o estado.json antigo íntegro, ou o novo — nunca
 * um arquivo pela metade. O .tmp pode ficar órfão após um crash, mas
 * é sobrescrito na próxima gravação.
 *
 * Serialização sem indentação (`JSON.stringify(dados)`) para reduzir
 * CPU e I/O: com ~5000 entradas de histórico, o arquivo fica em torno
 * de 750 KB (vs ~1.3 MB indentado). Para inspecionar visualmente:
 *   jq . estado.json
 *
 * A escrita é síncrona e bloqueia o event loop por ~10–20 ms a cada
 * chamada. Chamadas são raras: transições de bomba, mudanças de modo
 * ou limites, alertas e o tick periódico de 60 s. Aceitável.
 */
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

/* Grava o estado já normalizado logo após a carga. Garante que:
 *   1. O arquivo esteja no formato novo após o primeiro boot em uma
 *      instalação antiga (migração implícita).
 *   2. O evento sintético de "desligada" (se aplicável) seja persistido
 *      imediatamente — sem isso, dois crashes seguidos antes do próximo
 *      tick de 60 s empilhariam "desligada" duplicados em memória que
 *      nunca chegariam ao disco.
 *   3. O clamp de maximo (se aplicável) fique persistido — evita que o
 *      próximo boot precise re-clampar e logue novamente. */
salvarEstadoAgora();

/* ==================== AÇÕES DO SISTEMA ==================== */
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
  // Uma condição ativa gera apenas uma ocorrência no histórico até ser
  // resolvida. Evita registrar uma ocorrência por segundo em falhas contínuas.
  if (ativo && alertasAtivos.some((a) => a.tipo === tipo)) return;

  const alerta = {
    tipo,
    mensagem,
    dataHora: new Date().toISOString(),
  };
  if (nivel !== null) alerta.nivel = nivel;
  alertas.push(alerta);
  limitarTamanho(alertas, MAX_ALERTAS_MEMORIA);

  // Um alerta ativo representa uma condição ainda presente. O histórico
  // acima nunca é apagado quando a condição é resolvida.
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

// Emite o alerta "nivel_critico" apenas na transição (entrada) para a
// faixa crítica, evitando spam a cada leitura.
//
// Operador `<` (não `<=`) para alinhar com firmware e cliente:
//   - firmware NÃO liga a bomba quando nivel === minimo
//   - cliente NÃO mostra "Nível crítico" quando nivel === minimo
//   - servidor NÃO deve registrar alerta quando nivel === minimo
// Sem esse alinhamento, o dashboard mostrava "Nível normal" em verde
// enquanto o painel ao lado exibia "Nível crítico" — contraditório.
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

/* =========================================================
 * ESP32 ENVIA LEITURA E RECEBE COMANDO NA MESMA RESPOSTA
 *
 * O ESP32 aplica o comando no próximo POST (~1 s). A UI faz
 * atualização otimista ao clicar, então o usuário percebe a
 * resposta imediatamente; o relé pode levar até 1 s para acionar.
 * ========================================================= */
app.post("/api/nivel", (req, res) => {
  // Qualquer POST conta como "ESP32 vivo" para o watchdog
  ultimaLeituraRecebida = Date.now();

  const nivelBruto = req.body.nivel;
  const litrosBruto = req.body.litros;

  // Falha do sensor (−1): desliga a bomba também no estado do SERVIDOR
  // para que, em modo manual, uma recuperação posterior não "ressuscite"
  // a bomba com base em estado velho.
  if (nivelBruto !== undefined && Number(nivelBruto) === -1) {
    sistema.sensorOK = false;
    registrarAlerta("sensor_falha", "Falha na leitura do sensor.", null, true);

    // Falha do sensor é motivo de segurança → bomba OFF
    registrarAcionamento(false);

    // A janela de troca de modo não sobrevive a uma falha
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

  // Payload realmente malformado → 400
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

  // Campos derivados — FONTE DA VERDADE é o firmware. Aceitos como
  // OPCIONAIS para compatibilidade com versões antigas do base.ino que
  // ainda não os enviam. Quando ausentes ou inválidos, o servidor
  // mantém o valor anterior (0 no primeiro boot, ou último válido).
  // A UI exibe "--" enquanto forem 0.
  const alturaBruta = Number(req.body.alturaCm);
  if (Number.isFinite(alturaBruta) && alturaBruta >= 0) {
    sistema.alturaCm = alturaBruta;
  }
  const capacidadeBruta = Number(req.body.capacidadeLitros);
  if (Number.isFinite(capacidadeBruta) && capacidadeBruta > 0) {
    sistema.capacidadeLitros = capacidadeBruta;
  }

  // Corte de segurança no modo manual: além de desligar, fecha a janela
  // de modo e marca "comando manual já aplicado" para que o eco do ESP32
  // — que ainda pode reportar bombaLigada=true neste POST, pois o corte
  // local no firmware só ocorre APÓS esta requisição — não reative a
  // bomba no servidor. Sem isso, o corte era desfeito pelo eco.
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

  // Regras de quem é a fonte da verdade para o estado da bomba:
  // - AUTOMÁTICO: ESP32 é a fonte — aceita eco sempre.
  // - MANUAL, primeira leitura após troca e SEM comando do usuário:
  //   aceita o eco do ESP32 (estado físico atual).
  // - MANUAL, demais casos: usuário é a fonte — ignora eco.
  if (typeof req.body.bombaLigada === "boolean") {
    if (sistema.modo === "automatico") {
      registrarAcionamento(req.body.bombaLigada);
    } else if (modoRecemAlterado && !comandoManualDesdeTroca) {
      registrarAcionamento(req.body.bombaLigada);
    }
  }

  // A janela de troca de modo dura exatamente uma leitura
  modoRecemAlterado = false;
  comandoManualDesdeTroca = false;

  // Registra leitura no histórico (limita tamanho, inclui bomba e modo).
  // NÃO salva em disco a cada leitura — 1 POST/s × ~750 KB seria I/O
  // excessivo. A gravação fica a cargo do tick periódico de 60 s.
  historico.push({
    nivel: sistema.nivel,
    litros: sistema.litros,
    bombaLigada: sistema.bombaLigada,
    modo: sistema.modo,
    dataHora: new Date().toISOString(),
  });
  limitarTamanho(historico, MAX_HISTORICO_MEMORIA);

  verificarNivelCritico();

  // PIGGYBACK: devolve o comando junto com o ACK da leitura
  res.json({
    sucesso: true,
    modo: sistema.modo,
    minimo: sistema.minimo,
    maximo: sistema.maximo,
    bombaLigada: sistema.bombaLigada,
  });
});

/* ==================== CONSULTA E COMANDO ==================== */
// Rota de comando isolada — mantida apenas para debug (curl)
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

// Nunca devolver o array inteiro — apenas a janela servida à UI
app.get("/api/historico", (req, res) => {
  res.json(historico.slice(-HISTORICO_RESPOSTA));
});

app.get("/api/historico-bomba", (req, res) => {
  res.json(historicoBomba);
});

app.get("/api/alertas", (req, res) => {
  res.json(alertas); // histórico completo de ocorrências
});

app.get("/api/alertas/ativos", (req, res) => {
  res.json(alertasAtivos); // condições ainda não resolvidas
});

/* ==================== ESTATÍSTICAS AGREGADAS ==================== */
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

  // O consumo é calculado apenas entre amostras válidas consecutivas
  // dentro da sequência filtrada, sem deixar registros inválidos
  // contaminarem a soma.
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

  // Nunca aceita ligar acima do limite de segurança universal. Antes,
  // a rota só checava sistema.maximo — se maximo=100 fosse configurado,
  // ligar em nível ≥ 98 era aceito e, na leitura seguinte, o firmware
  // derrubava o relé. Entre o clique e a próxima leitura, /api/status
  // reportava bombaLigada=true com o relé ainda aberto (janela ~1 s).
  // Bloqueando o comando na origem, essa janela desaparece.
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

  // A partir daqui, o comando do usuário vence o eco do ESP32
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

  // Abre a janela para a primeira leitura após a troca
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

  // Validação básica: números finitos e ordenados. Sem isso, um payload
  // como {"minimo": "abc", "maximo": "xyz"} passaria por engano (NaN >= NaN
  // é false).
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

  // Trava de coerência com o firmware: o ESP32 corta a bomba em
  // NIVEL_CORTE_SEGURANCA (98%). Aceitar maximo ≥ 98 permitiria ao
  // usuário configurar uma faixa em que o corte de segurança dispararia
  // sempre antes do "máximo", gerando comportamento confuso. Bloqueamos
  // na origem.
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

/* ==================== WATCHDOG E PERSISTÊNCIA ==================== */
// Se ficarmos TIMEOUT_ESP32_MS sem nenhum POST de leitura, marca
// sensorOK=false para que o banner do dashboard alerte o usuário.
setInterval(() => {
  const silencioMs = Date.now() - ultimaLeituraRecebida;
  if (silencioMs <= TIMEOUT_ESP32_MS) return;
  if (sistema.sensorOK === false) return; // já marcado, não spammar

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

  // Não mantenha o estado lógico da bomba ligado quando o ESP32 some
  // durante operação manual. O firmware também desliga localmente no
  // primeiro POST que falhar; este corte sincroniza o estado do servidor.
  if (sistema.modo === "manual" && sistema.bombaLigada) {
    registrarAcionamento(false);
  }
}, INTERVALO_WATCHDOG_MS);

// Persistência periódica (60 s) e em shutdown. O tick cobre o caso de
// o processo rodar por muito tempo sem transições de bomba/alertas —
// nesse cenário, o histórico de leituras só seria salvo neste tick.
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
