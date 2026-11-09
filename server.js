const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

let sistema = {
  nivel: 0,
  litros: 0,
  bombaLigada: false,
  modo: "automatico",
  minimo: 30,
  maximo: 90,
  sensorOK: true,
};

let historico = [];
let historicoBomba = [];
let alertas = [];
let nivelCriticoAtivo = false;

function registrarAcionamento(novoEstado) {
  if (sistema.bombaLigada !== novoEstado) {
    sistema.bombaLigada = novoEstado;
    historicoBomba.push({
      estado: novoEstado ? "ligada" : "desligada",
      modo: sistema.modo,
      dataHora: new Date().toISOString(),
    });
  }
}

function verificarNivelCritico() {
  if (sistema.nivel <= sistema.minimo) {
    if (!nivelCriticoAtivo) {
      alertas.push({
        tipo: "nivel_critico",
        mensagem: "Nível de água crítico.",
        nivel: sistema.nivel,
        dataHora: new Date().toISOString(),
      });
      nivelCriticoAtivo = true;
    }
  } else {
    nivelCriticoAtivo = false;
  }
}

/* ESP32 ENVIA LEITURA E RECEBE COMANDO NA MESMA RESPOSTA (PIGGYBACK) */
app.post("/api/nivel", (req, res) => {
  const nivel = Number(req.body.nivel);
  const litros = Number(req.body.litros);

  if (
    req.body.nivel === undefined ||
    req.body.nivel === null ||
    req.body.nivel === "" ||
    !Number.isFinite(nivel) ||
    nivel < 0 ||
    nivel > 100 ||
    req.body.litros === undefined ||
    req.body.litros === null ||
    req.body.litros === "" ||
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

  // ESP32 é a fonte da verdade sobre o estado real da bomba
  if (typeof req.body.bombaLigada === "boolean") {
    registrarAcionamento(req.body.bombaLigada);
  }

  historico.push({
    nivel: sistema.nivel,
    litros: sistema.litros,
    dataHora: new Date().toISOString(),
  });

  verificarNivelCritico();

  // PIGGYBACK: devolve o comando junto com o ACK da leitura.
  // O ESP32 não precisa mais de uma segunda requisição GET.
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

app.get("/api/historico", (req, res) => {
  res.json(historico);
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

  if (req.body.ligar && sistema.nivel >= sistema.maximo) {
    return res.status(400).json({
      erro: "Limite máximo atingido.",
    });
  }

  registrarAcionamento(req.body.ligar);

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

  verificarNivelCritico();

  res.json(sistema);
});

app.listen(PORT, () => {
  console.log(`AquaLevel rodando em http://localhost:${PORT}`);
});
