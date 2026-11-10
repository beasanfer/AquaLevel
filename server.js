const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* Item 5: persistência do estado em arquivo. */
const ARQUIVO_ESTADO = path.join(__dirname, "estado.json");

/* Item (c): limites para evitar crescimento infinito dos arrays em memória. */
const MAX_HISTORICO_MEMORIA = 5000; // ~1h20 de leituras (1/s)
const HISTORICO_RESPOSTA = 1000; // últimos 1000 servidos à UI
const MAX_HISTORICO_BOMBA_MEMORIA = 500; // acionamentos são esparsos
const MAX_ALERTAS_MEMORIA = 200;

/* Item (e): watchdog de comunicação com o ESP32. */
const TIMEOUT_ESP32_MS = 15000;
const INTERVALO_WATCHDOG_MS = 5000;

app.use(express.json());

/* 3.7: caminho do estático resolvido em relação a __dirname (não ao
 * CWD). Assim `node server.js` funciona independentemente do diretório
 * de onde foi invocado. */
app.use(express.static(path.join(__dirname, "public")));

const estadoPadrao = {
  nivel: 0,
  litros: 0,
  bombaLigada: false,
  modo: "automatico",
  minimo: 30,
  maximo: 90,
  sensorOK: true,
};

function carregarEstado() {
  try {
    if (fs.existsSync(ARQUIVO_ESTADO)) {
      const bruto = fs.readFileSync(ARQUIVO_ESTADO, "utf8");
      const salvo = JSON.parse(bruto);
      console.log(`Estado restaurado de ${ARQUIVO_ESTADO}`);

      /* 3.4: força bomba DESLIGADA após reboot. Nunca religamos a bomba
       * por conta de um estado salvo em disco — se estava ligada antes
       * de uma queda de energia, o operador precisa confirmar
       * novamente (via modo manual + comando explícito, ou aguardar o
       * controle automático religar ao cair abaixo do mínimo). */
      const restaurado = { ...estadoPadrao, ...salvo };
      restaurado.bombaLigada = false;
      return restaurado;
    }
  } catch (e) {
    console.error("Falha ao carregar estado:", e.message);
  }
  return { ...estadoPadrao };
}

function salvarEstadoAgora() {
  try {
    fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(sistema, null, 2));
  } catch (e) {
    console.error("Falha ao salvar estado:", e.message);
  }
}

let sistema = carregarEstado();

let historico = [];
let historicoBomba = [];
let alertas = [];
let nivelCriticoAtivo = false;

/* Item (e): timestamp da última leitura recebida do ESP32.
 * Inicializado no boot — se o ESP32 não falar em TIMEOUT_ESP32_MS,
 * consideramos que está offline. */
let ultimaLeituraRecebida = Date.now();

/* Item (b): controle da janela de troca de modo.
 * - modoRecemAlterado: true entre /api/modo(manual) e a próxima leitura do ESP32.
 * - comandoManualDesdeTroca: true se o usuário já deu comando de bomba
 *   nessa janela — nesse caso, o comando do usuário vence o eco do ESP32. */
let modoRecemAlterado = false;
let comandoManualDesdeTroca = false;

/* Item 4: corte de segurança em modo manual. */
const LIMITE_SEGURANCA_MANUAL = 98;

/* ---------- Helpers (item c) ---------- */

function limitarTamanho(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/* ---------- Ações do sistema ---------- */

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

function registrarAlerta(tipo, mensagem, nivel = null) {
  const alerta = {
    tipo,
    mensagem,
    dataHora: new Date().toISOString(),
  };
  if (nivel !== null) alerta.nivel = nivel;
  alertas.push(alerta);
  limitarTamanho(alertas, MAX_ALERTAS_MEMORIA);
}

function verificarNivelCritico() {
  if (sistema.nivel <= sistema.minimo) {
    if (!nivelCriticoAtivo) {
      registrarAlerta("nivel_critico", "Nível de água crítico.", sistema.nivel);
      nivelCriticoAtivo = true;
    }
  } else {
    nivelCriticoAtivo = false;
  }
}

/* =========================================================
 * ESP32 ENVIA LEITURA E RECEBE COMANDO NA MESMA RESPOSTA
 *
 * NOTA (item 7): o ESP32 aplica o comando no próximo POST (~1 s).
 * A UI faz atualização otimista ao clicar, então o usuário percebe a
 * resposta imediatamente; o relé pode levar até 1 s para acionar.
 * ========================================================= */
app.post("/api/nivel", (req, res) => {
  /* Item (e): qualquer POST conta como "ESP32 vivo". */
  ultimaLeituraRecebida = Date.now();

  const nivelBruto = req.body.nivel;
  const litrosBruto = req.body.litros;

  /* Item 8 + (a): falha do sensor (−1).
   * Desliga a bomba por segurança também no estado do SERVIDOR, para que
   * em modo manual uma recuperação posterior não "ressuscite" a bomba
   * com base em estado velho. */
  if (nivelBruto !== undefined && Number(nivelBruto) === -1) {
    sistema.sensorOK = false;

    /* (a): falha do sensor é motivo de segurança → bomba OFF. */
    registrarAcionamento(false);

    /* (b): a janela de troca de modo não sobrevive a uma falha. */
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

  /* Payload realmente malformado → 400. */
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
  sistema.nivel = nivel;
  sistema.litros = litros;

  /* Item 4: corte de segurança no modo manual.
   *
   * (Correção B) Além de desligar, fechamos a janela de modo e marcamos
   * "comando manual já aplicado" para que o eco do ESP32 — que ainda
   * pode reportar bombaLigada=true neste POST, pois o corte local no
   * firmware só ocorre APÓS esta requisição — não reative a bomba no
   * servidor. Sem isso, o corte era desfeito logo em seguida pelo eco. */
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

  /* =========================================================
   * (b) + correção do modo manual:
   *
   * - AUTOMÁTICO: ESP32 é fonte da verdade — aceita eco sempre.
   * - MANUAL, primeira leitura após troca e SEM comando do usuário:
   *   aceita o eco do ESP32 (é o estado físico atual; o servidor
   *   não tem informação mais recente que isso).
   * - MANUAL, demais casos: usuário é fonte da verdade — ignora eco.
   * ========================================================= */
  if (typeof req.body.bombaLigada === "boolean") {
    if (sistema.modo === "automatico") {
      registrarAcionamento(req.body.bombaLigada);
    } else if (modoRecemAlterado && !comandoManualDesdeTroca) {
      registrarAcionamento(req.body.bombaLigada);
    }
  }

  /* A janela de troca de modo dura exatamente uma leitura. */
  modoRecemAlterado = false;
  comandoManualDesdeTroca = false;

  /* Item (c): limitar histórico em memória.
   * Item (d): incluir bomba e modo no registro histórico. */
  historico.push({
    nivel: sistema.nivel,
    litros: sistema.litros,
    bombaLigada: sistema.bombaLigada,
    modo: sistema.modo,
    dataHora: new Date().toISOString(),
  });
  limitarTamanho(historico, MAX_HISTORICO_MEMORIA);

  verificarNivelCritico();

  // PIGGYBACK: devolve o comando junto com o ACK da leitura.
  res.json({
    sucesso: true,
    modo: sistema.modo,
    minimo: sistema.minimo,
    maximo: sistema.maximo,
    bombaLigada: sistema.bombaLigada,
  });
});

/* Rota de comando isolada — mantida apenas para debug (curl). */
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

/* Item (c): nunca devolver o array inteiro. */
app.get("/api/historico", (req, res) => {
  res.json(historico.slice(-HISTORICO_RESPOSTA));
});

app.get("/api/historico-bomba", (req, res) => {
  res.json(historicoBomba);
});

app.get("/api/alertas", (req, res) => {
  res.json(alertas);
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

  /* 3.3: nunca aceita ligar acima do limite de segurança universal.
   * Antes, /api/bomba só checava sistema.maximo — se o usuário
   * configurasse maximo=100, um comando de ligar em nível ≥ 98 era
   * aceito e, na leitura seguinte, o firmware derrubava o relé. Entre
   * o clique e a próxima leitura, /api/status reportava bombaLigada=true
   * com o relé ainda aberto (a janela de ~1 s). Bloqueando o comando
   * na origem, essa janela desaparece nesse caso crítico. */
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

  /* (b): a partir daqui, o comando do usuário vence o eco do ESP32. */
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

  /* (b): abre a janela para a primeira leitura após a troca. */
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

  if (minimo >= maximo) {
    return res.status(400).json({
      erro: "Limites inválidos.",
    });
  }

  sistema.minimo = minimo;
  sistema.maximo = maximo;
  salvarEstadoAgora();

  verificarNivelCritico();

  res.json(sistema);
});

/* =========================================================
 * Item (e): watchdog de comunicação com o ESP32.
 * Se ficarmos TIMEOUT_ESP32_MS sem nenhum POST de leitura, marcamos
 * sensorOK=false para que o banner do dashboard alerte o usuário.
 * ========================================================= */
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
  );
}, INTERVALO_WATCHDOG_MS);

/* Item 5: garante persistência periódica e em shutdown. */
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
