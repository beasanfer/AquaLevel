/**
 * AquaLevel | Servidor e API REST
 *
 * Serve o dashboard, recebe a telemetria do ESP32 e controla o estado
 * lógico do sistema. A confirmação física da bomba vem do firmware.
 */

// ===========================================================================
// 01. Dependências e parâmetros do servidor
// ===========================================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

/* Persistência em estado.json: dados sujeitos à durabilidade do disco.
 * Armazenamento efêmero é uma limitação conhecida e aceita neste projeto. */
const ARQUIVO_ESTADO = path.join(__dirname, "estado.json");

// Limita a quantidade de registros em memória e em estado.json.
const MAX_HISTORICO_MEMORIA = 5000; // cerca de 83 min com 1 leitura/s
const HISTORICO_RESPOSTA = 1000; // janela mais recente exibida na UI
const MAX_HISTORICO_BOMBA_MEMORIA = 500; // transições da bomba
const MAX_ALERTAS_MEMORIA = 200;

// Watchdog: considera o ESP32 silencioso após 15 s sem POST.
const TIMEOUT_ESP32_MS = 15000;
const INTERVALO_WATCHDOG_MS = 5000;
// Um comando não confirmado deixa de ser entregue após 10 segundos.
const VALIDADE_COMANDO_MANUAL_MS = 10000;
// Controla solicitações originadas da mesma página: um pedido antigo de
// "ligar" não pode substituir um "desligar" enviado depois dela.
// Clientes antigos sem esses campos continuam funcionando, porém sem a
// garantia de ordenação entre requisições concorrentes.
const MAX_CLIENTES_CONTROLE = 1024;
const ultimasSequenciasControle = new Map();

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

// ===========================================================================
// 02. Utilitários e ordenação de comandos
// ===========================================================================
// Descarta os registros mais antigos quando o limite é excedido.
function limitarTamanho(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// Requisições sem objeto JSON (inclusive arrays) não podem causar exceção
// nem ser convertidas implicitamente em campos válidos.
function obterCorpoJSON(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

// A sequência é compartilhada entre /api/bomba e /api/modo para impedir que
// uma requisição atrasada reverta uma intenção mais recente do mesmo painel.
// Os registros são limitados para não crescer indefinidamente em memória.
function verificarSequenciaControle(corpo) {
  const id = corpo.clienteControleId;
  const sequencia = corpo.sequenciaControle;

  if (id === undefined && sequencia === undefined) return { legado: true };

  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(id) ||
    !Number.isSafeInteger(sequencia) ||
    sequencia < 1
  ) {
    return { erro: "Identificação ou sequência de comando inválida.", status: 400 };
  }

  const anterior = ultimasSequenciasControle.get(id);

  if (anterior !== undefined && sequencia <= anterior)
    return { erro: "Comando antigo ignorado: há uma solicitação mais recente.", status: 409 };

  return { id, sequencia };
}

function registrarSequenciaControle(ordem) {
  if (!ordem.id) return; // Compatibilidade com chamadas antigas da API.

  // Reinsere a chave no fim, permitindo remover as menos recentes.
  ultimasSequenciasControle.delete(ordem.id);
  ultimasSequenciasControle.set(ordem.id, ordem.sequencia);

  if (ultimasSequenciasControle.size > MAX_CLIENTES_CONTROLE)
    ultimasSequenciasControle.delete(ultimasSequenciasControle.keys().next().value);
}

// ===========================================================================
// 03. Estado inicial e variáveis compartilhadas
// ===========================================================================
const estadoPadraoSistema = {
  nivel: 0,
  litros: 0,
  alturaCm: 0,
  capacidadeLitros: 0,
  // bombaLigada preserva o último estado comunicado (para o histórico).
  bombaLigada: false,
  // null = estado físico desconhecido, inclusive durante uma desconexão.
  bombaConfirmada: null,
  bombaDesejada: false,
  comandoPendente: false,
  esp32Online: false,
  bloqueioManual: false,
  ultimaMensagemDataHora: null,
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

// O heartbeat só é renovado depois da validação de um POST de telemetria.
// Inicia no boot apenas para disparar o primeiro alerta se não houver conexão.
let ultimaLeituraRecebida = Date.now();
// Não persistimos comandos: reiniciar o servidor nunca deve religar a bomba.
let comandoManualPendente = null;
let ultimaSessaoESP32 = null;

// ===========================================================================
// 04. Restauração do estado
// ===========================================================================
/* RESTAURAÇÃO DO ESTADO
 * Suporta estado.json no formato atual e legados.
 * Mantém a última leitura histórica, mas NÃO inventa um desligamento
 * físico: a confirmação atual permanece null até a nova telemetria. */
function carregarEstado() {
  try {
    if (!fs.existsSync(ARQUIVO_ESTADO)) return;

    const bruto = fs.readFileSync(ARQUIVO_ESTADO, "utf8");
    const salvo = JSON.parse(bruto);
    const novoSistema = salvo.sistema !== undefined ? salvo.sistema : salvo;

    sistema = { ...estadoPadraoSistema, ...novoSistema };

    /* Migra limites antigos: mínimo >= 1%, máximo <= 97% e mínimo
     * estritamente menor que o máximo. Nunca restaura mínimo 0%. */
    const maximoSalvo = Number(sistema.maximo);
    const minimoSalvo = Number(sistema.minimo);

    sistema.maximo =
      Number.isFinite(maximoSalvo) && maximoSalvo > 1
        ? Math.min(maximoSalvo, LIMITE_SEGURANCA_MANUAL - 1)
        : estadoPadraoSistema.maximo;
    sistema.minimo =
      Number.isFinite(minimoSalvo) && minimoSalvo >= 1
        ? Math.min(minimoSalvo, sistema.maximo - 1)
        : 1;

    // A última leitura é histórica, não uma confirmação física presente.
    sistema.bombaLigada = sistema.bombaLigada === true;
    // O arquivo não prova o estado físico do relé após um reinício.
    sistema.bombaConfirmada = null;
    sistema.bombaDesejada = false;
    sistema.comandoPendente = false;
    sistema.esp32Online = false;
    sistema.bloqueioManual = false;
    sistema.ultimaMensagemDataHora = null;

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

    console.log(
      `Estado restaurado de ${ARQUIVO_ESTADO} ` +
        `(${historico.length} leituras, ${historicoBomba.length} acionamentos, ` +
        `${alertas.length} alertas).`,
    );
  } catch (e) {
    console.error("Falha ao carregar estado:", e.message);
  }
}

// ===========================================================================
// 05. Persistência do estado
// ===========================================================================
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

// Salva os valores normalizados após a restauração.
salvarEstadoAgora();

// ===========================================================================
// 06. Históricos, mudanças de estado e alertas
// ===========================================================================
// Registra e persiste apenas transições efetivas do estado da bomba.
function registrarAcionamento(novoEstado, modoEfetivo) {
  if (sistema.bombaLigada !== novoEstado) {
    sistema.bombaLigada = novoEstado;

    historicoBomba.push({
      estado: novoEstado ? "ligada" : "desligada",
      // O modo é o reportado pelo ESP32; nunca inferido do servidor.
      modo: modoEfetivo,
      dataHora: new Date().toISOString(),
    });

    limitarTamanho(historicoBomba, MAX_HISTORICO_BOMBA_MEMORIA);
    salvarEstadoAgora();
  }
}

function registrarAlerta(tipo, mensagem, nivel = null, ativo = false) {
  // Evita duplicar ocorrências enquanto o mesmo alerta está ativo.
  if (ativo && alertasAtivos.some((a) => a.tipo === tipo)) return;

  const alerta = { tipo, mensagem, dataHora: new Date().toISOString() };

  if (nivel !== null) alerta.nivel = nivel;

  alertas.push(alerta);
  limitarTamanho(alertas, MAX_ALERTAS_MEMORIA);

  // A verificação inicial já descartou alertas ativos duplicados.
  if (ativo) {
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
  if (sistema.nivel >= sistema.minimo) {
    nivelCriticoAtivo = false;
    resolverAlerta("nivel_critico");

    return;
  }

  if (nivelCriticoAtivo) return;

  registrarAlerta("nivel_critico", "Nível de água crítico.", sistema.nivel, true);
  nivelCriticoAtivo = true;
}

// ===========================================================================
// 07. Comandos manuais e confirmação física
// ===========================================================================
/* COMANDOS MANUAIS E CONFIRMAÇÃO
 * O backend guarda a intenção, mas somente o ESP32 confirma o estado físico.
 * Um comando tem identificador único, expiração e confirmação por telemetria.
 * Nunca se reenvia um comando antigo depois de reinício ou queda de comunicação. */
function cancelarComandoManual() {
  comandoManualPendente = null;
  sistema.comandoPendente = false;
  sistema.bombaDesejada = sistema.bombaConfirmada === true;
}

function expirarComandoManual() {
  if (comandoManualPendente && Date.now() >= comandoManualPendente.expiraEm)
    cancelarComandoManual();
}

function criarComandoManual(ligar) {
  comandoManualPendente = {
    id: randomUUID(),
    ligar,
    expiraEm: Date.now() + VALIDADE_COMANDO_MANUAL_MS,
  };

  sistema.comandoPendente = true;
  sistema.bombaDesejada = ligar;
}

function registrarHeartbeat(corpo) {
  // Sessões mudam a cada reinicialização do ESP32; comandos antigos expiram
  // imediatamente ao detectarmos um novo boot, mesmo dentro dos 10 segundos.
  const sessao =
    typeof corpo.sessaoESP32 === "string" && /^[a-fA-F0-9-]{1,64}$/.test(corpo.sessaoESP32)
      ? corpo.sessaoESP32
      : null;

  if (sessao !== null) {
    if (ultimaSessaoESP32 !== null && ultimaSessaoESP32 !== sessao) cancelarComandoManual();

    ultimaSessaoESP32 = sessao;
  }

  const bloqueado = corpo.bloqueioManual === true;

  // Na primeira indicação da trava, descarta comandos emitidos antes dela.
  // Comandos NOVOS, criados depois da trava, continuam entregáveis.
  if (bloqueado && !sistema.bloqueioManual) cancelarComandoManual();

  sistema.bloqueioManual = bloqueado;
  ultimaLeituraRecebida = Date.now();
  sistema.ultimaMensagemDataHora = new Date().toISOString();
  sistema.esp32Online = true;

  resolverAlerta("esp32_offline");
}

function modoReportado(corpo) {
  return corpo.modoESP32 === "manual" || corpo.modoESP32 === "automatico" ? corpo.modoESP32 : null;
}

// Apenas o ESP32 confirma o estado do GPIO e o modo usado na transição.
function registrarEcoDaBomba(corpo) {
  const modoEfetivo = modoReportado(corpo);

  registrarAcionamento(corpo.bombaLigada, modoEfetivo);
  sistema.bombaConfirmada = corpo.bombaLigada;
  expirarComandoManual();

  // Mesmo se a segurança local recusou o acionamento, a intenção antiga
  // não deve ficar pendente e ser aplicada em outro ciclo.
  if (comandoManualPendente && corpo.comandoAplicadoId === comandoManualPendente.id) {
    cancelarComandoManual();
  }
  if (!comandoManualPendente) {
    sistema.bombaDesejada = sistema.bombaConfirmada === true;
  }
}

// Campos retornados ao firmware, inclusive quando o sensor falha.
function configuracaoParaESP32() {
  return {
    modo: sistema.modo,
    minimo: sistema.minimo,
    maximo: sistema.maximo,
    bombaLigada: sistema.bombaLigada,
  };
}

/* Apenas telemetria válida atualiza o watchdog. A sessão identifica
 * reinicializações, mas não autentica o dispositivo. */
// ===========================================================================
// 08. Recebimento de telemetria do ESP32
// ===========================================================================
app.post("/api/nivel", (req, res) => {
  const corpo = obterCorpoJSON(req);
  const nivel = corpo.nivel;
  const litros = corpo.litros;
  const falhaSensor = nivel === -1;

  // O ArduinoJson emite números JSON. Impedir coerções evita aceitar [] como
  // zero, strings vazias como zero, true como um e outros tipos inesperados.
  const nivelValido =
    typeof nivel === "number" &&
    Number.isFinite(nivel) &&
    (falhaSensor || (nivel >= 0 && nivel <= 100));

  const litrosValidos = typeof litros === "number" && Number.isFinite(litros) && litros >= 0;

  if (
    !nivelValido ||
    !litrosValidos ||
    typeof corpo.bombaLigada !== "boolean" ||
    (corpo.modoESP32 !== undefined &&
      corpo.modoESP32 !== "manual" &&
      corpo.modoESP32 !== "automatico") ||
    (falhaSensor && corpo.bombaLigada !== false)
  ) {
    return res
      .status(400)
      .json({ sucesso: false, erro: "Leitura inválida do sensor.", ...configuracaoParaESP32() });
  }

  registrarHeartbeat(corpo);
  registrarEcoDaBomba(corpo);

  if (falhaSensor) {
    sistema.sensorOK = false;

    cancelarComandoManual();
    registrarAlerta("sensor_falha", "Falha na leitura do sensor.", null, true);

    return res.status(200).json({
      sucesso: false,
      sensorOK: false,
      erro: "Falha na leitura do sensor.",
      ...configuracaoParaESP32(),
      comandoManual: null,
    });
  }

  sistema.sensorOK = true;

  resolverAlerta("sensor_falha");

  sistema.ultimaLeituraDataHora = new Date().toISOString();
  sistema.nivel = nivel;
  sistema.litros = litros;

  // Campos opcionais mantidos por compatibilidade: o firmware não os envia.
  if (corpo.alturaCm !== undefined) {
    const alturaBruta = Number(corpo.alturaCm);

    if (Number.isFinite(alturaBruta) && alturaBruta >= 0) sistema.alturaCm = alturaBruta;
  }
  if (corpo.capacidadeLitros !== undefined) {
    const capacidadeBruta = Number(corpo.capacidadeLitros);

    if (Number.isFinite(capacidadeBruta) && capacidadeBruta > 0)
      sistema.capacidadeLitros = capacidadeBruta;
  }

  // O modo manual respeita o máximo configurável, além do corte fixo de 98%.
  // Esta checagem vem DEPOIS do eco para não aceitar um comando velho
  // quando a telemetria chega simultaneamente ao limite.
  if (sistema.modo === "manual" && sistema.nivel >= sistema.maximo) {
    if (comandoManualPendente?.ligar === true) {
      cancelarComandoManual();
    }

    if (sistema.bombaConfirmada === true) {
      if (!comandoManualPendente || comandoManualPendente.ligar !== false)
        criarComandoManual(false);

      registrarAlerta(
        "corte_seguranca",
        `Limite máximo atingido em modo manual (${sistema.nivel}%): desligamento solicitado.`,
        sistema.nivel,
        true,
      );
    } else {
      resolverAlerta("corte_seguranca");
    }
  } else {
    resolverAlerta("corte_seguranca");
  }

  if (sistema.modo === "automatico" && !comandoManualPendente)
    sistema.bombaDesejada = sistema.bombaConfirmada === true;

  historico.push({
    nivel: sistema.nivel,
    litros: sistema.litros,
    bombaLigada: sistema.bombaLigada,
    modo: modoReportado(corpo),
    dataHora: new Date().toISOString(),
  });

  limitarTamanho(historico, MAX_HISTORICO_MEMORIA);
  verificarNivelCritico();

  expirarComandoManual();

  const podeEnviar =
    sistema.modo === "manual" &&
    ultimaSessaoESP32 !== null &&
    corpo.sessaoESP32 === ultimaSessaoESP32;

  // Só o comando solicitado é transmitido; bombaLigada agora é TELEMETRIA.
  const comandoManual =
    podeEnviar && comandoManualPendente
      ? { id: comandoManualPendente.id, ligar: comandoManualPendente.ligar }
      : null;

  res.json({ sucesso: true, ...configuracaoParaESP32(), comandoManual });
});

// ===========================================================================
// 09. Consultas e operações da API
// ===========================================================================
// Consulta de comando sem alterações de estado.
app.get("/api/comando", (req, res) => {
  expirarComandoManual();
  verificarWatchdog();

  res.json({
    bombaLigada: sistema.bombaLigada,
    bombaConfirmada: sistema.bombaConfirmada,
    bombaDesejada: sistema.bombaDesejada,
    comandoPendente: sistema.comandoPendente,
    modo: sistema.modo,
    minimo: sistema.minimo,
    maximo: sistema.maximo,
  });
});

app.get("/api/status", (req, res) => {
  expirarComandoManual();
  verificarWatchdog();
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

/* Estatísticas do histórico retido: null significa ausência de dados.
 * O consumo é a soma das reduções de volume entre leituras válidas. */
app.get("/api/estatisticas", (req, res) => {
  const acionamentos = historicoBomba.filter((e) => e.estado === "ligada").length;

  const amostrasValidas = historico.filter((h) => {
    const n = Number(h.nivel);
    const l = Number(h.litros);

    return Number.isFinite(n) && n >= 0 && n <= 100 && Number.isFinite(l) && l >= 0;
  });

  if (amostrasValidas.length === 0) {
    return res.json({
      nivelMedio: null,
      nivelMaximo: null,
      nivelMinimo: null,
      consumoEstimado: null,
      acionamentos,
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
  const corpo = obterCorpoJSON(req);

  if (sistema.modo !== "manual") {
    return res.status(400).json({ erro: "Controle manual indisponível." });
  }
  if (typeof corpo.ligar !== "boolean") {
    return res.status(400).json({ erro: "Estado da bomba inválido." });
  }

  const ordem = verificarSequenciaControle(corpo);

  if (ordem.erro) return res.status(ordem.status).json({ erro: ordem.erro });

  // Bloqueia o comando manual de ligar quando o nível atingiu o
  // limite de segurança, independentemente do máximo configurado.
  if (corpo.ligar && sistema.nivel >= LIMITE_SEGURANCA_MANUAL) {
    return res.status(400).json({
      erro: `Bomba não pode ser ligada. Limite de segurança atingido (≥ ${LIMITE_SEGURANCA_MANUAL}%).`,
    });
  }

  if (corpo.ligar && sistema.nivel >= sistema.maximo)
    return res.status(400).json({ erro: "Limite máximo atingido." });

  expirarComandoManual();
  verificarWatchdog();

  // O comando de ligar exige um ESP32 vivo, sensor íntegro e uma sessão
  // identificada. O desligamento permanece permitido mesmo se estiver offline.
  if (corpo.ligar && (!sistema.esp32Online || !sistema.sensorOK || ultimaSessaoESP32 === null))
    return res.status(409).json({ erro: "ESP32 sem comunicação válida ou sensor indisponível." });

  // Somente pedidos aceitos avançam a sequência. Uma requisição atrasada
  // de ligar não pode se sobrepor a um desligamento mais recente.
  registrarSequenciaControle(ordem);

  // Esta requisição NÃO modifica o estado confirmado nem o histórico.
  // Eles serão atualizados no próximo POST com o eco do ESP32.
  criarComandoManual(corpo.ligar);
  salvarEstadoAgora();
  res.json(sistema);
});

app.post("/api/modo", (req, res) => {
  const corpo = obterCorpoJSON(req);
  const modo = corpo.modo;

  if (modo !== "manual" && modo !== "automatico")
    return res.status(400).json({ erro: "Modo inválido." });

  const ordem = verificarSequenciaControle(corpo);

  if (ordem.erro) return res.status(ordem.status).json({ erro: ordem.erro });

  registrarSequenciaControle(ordem);

  if (sistema.modo !== modo) {
    sistema.modo = modo;
    cancelarComandoManual();

    // Ao entrar em manual, o firmware interrompe a bomba até novo comando.
    if (modo === "manual") sistema.bombaDesejada = false;

    salvarEstadoAgora();
  }

  res.json(sistema);
});

app.post("/api/limites", (req, res) => {
  const corpo = obterCorpoJSON(req);
  const minimo = corpo.minimo;
  const maximo = corpo.maximo;

  // Limites precisam ser números JSON reais: mínimo >= 1%, mínimo < máximo.
  if (
    typeof minimo !== "number" ||
    !Number.isFinite(minimo) ||
    typeof maximo !== "number" ||
    !Number.isFinite(maximo) ||
    minimo < 1 ||
    minimo >= maximo
  ) {
    return res.status(400).json({ erro: "Limites inválidos." });
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

  // Um comando pendente de ligar deixa de ser válido se o novo máximo
  // passou a proibir essa operação no nível já medido.
  if (comandoManualPendente?.ligar === true && sistema.nivel >= maximo) cancelarComandoManual();

  salvarEstadoAgora();
  verificarNivelCritico();
  res.json(sistema);
});

// ===========================================================================
// 10. Watchdog, salvamento e inicialização
// ===========================================================================
// Falha de comunicação é independente de falha do sensor. Não inventamos
// um desligamento físico quando só perdemos a comunicação com o ESP32.
function verificarWatchdog() {
  const silencioMs = Date.now() - ultimaLeituraRecebida;

  if (silencioMs <= TIMEOUT_ESP32_MS) return;

  const estavaOnline = sistema.esp32Online;

  sistema.esp32Online = false;
  sistema.bombaConfirmada = null;
  sistema.bombaDesejada = false;

  if (estavaOnline) cancelarComandoManual();

  registrarAlerta(
    "esp32_offline",
    `ESP32 sem comunicação há mais de ${Math.round(TIMEOUT_ESP32_MS / 1000)} segundos.`,
    null,
    true,
  );
}

setInterval(() => {
  expirarComandoManual();
  verificarWatchdog();
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
