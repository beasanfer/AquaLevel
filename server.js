const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

let sistema = {
    nivel: 72,
    litros: 720,
    bombaLigada: true,
    modo: "automatico",
    minimo: 30,
    maximo: 90,
    sensorOK: true
};

/* HISTÓRICO DE MEDIÇÕES */
let historico = [];

/* HISTÓRICO DE ACIONAMENTOS DA BOMBA */
let historicoBomba = [];

/* ALERTAS DE NÍVEL CRÍTICO */
let alertas = [];
let nivelCriticoAtivo = false;

/* REGISTRAR ALTERAÇÃO DE ESTADO DA BOMBA */
function registrarAcionamento(novoEstado) {
    if (sistema.bombaLigada !== novoEstado) {
        sistema.bombaLigada = novoEstado;

        historicoBomba.push({
            estado: novoEstado ? "ligada" : "desligada",
            modo: sistema.modo,
            dataHora: new Date().toISOString()
        });
    }
}

/* VERIFICAR NÍVEL CRÍTICO */
function verificarNivelCritico() {
    if (sistema.nivel <= sistema.minimo) {
        if (!nivelCriticoAtivo) {
            alertas.push({
                tipo: "nivel_critico",
                mensagem: "Nível de água crítico.",
                nivel: sistema.nivel,
                dataHora: new Date().toISOString()
            });

            nivelCriticoAtivo = true;
        }
    } else {
        nivelCriticoAtivo = false;
    }
}

/* CONTROLE AUTOMÁTICO DA BOMBA */
function controleAutomatico() {
    if (sistema.nivel <= sistema.minimo) {
        registrarAcionamento(true);
    } else if (sistema.nivel >= sistema.maximo) {
        registrarAcionamento(false);
    }
}

/* ESP32 ENVIA LEITURA */
app.post("/api/nivel", (req, res) => {
    sistema.nivel = Number(req.body.nivel);
    sistema.litros = Number(req.body.litros);

    /* REGISTRAR MEDIÇÃO NO HISTÓRICO */
    historico.push({
        nivel: sistema.nivel,
        litros: sistema.litros,
        dataHora: new Date().toISOString()
    });

    /* VERIFICAR ALERTA DE NÍVEL CRÍTICO */
    verificarNivelCritico();

    if (sistema.modo === "automatico") {
        controleAutomatico();
    }

    res.json({
        sucesso: true
    });
});

/* DASHBOARD CONSULTA */
app.get("/api/status", (req, res) => {
    res.json(sistema);
});

/* CONSULTAR HISTÓRICO DE MEDIÇÕES */
app.get("/api/historico", (req, res) => {
    res.json(historico);
});

/* CONSULTAR HISTÓRICO DE ACIONAMENTOS */
app.get("/api/historico-bomba", (req, res) => {
    res.json(historicoBomba);
});

/* CONSULTAR ALERTAS */
app.get("/api/alertas", (req, res) => {
    res.json(alertas);
});

/* ALTERAR BOMBA */
app.post("/api/bomba", (req, res) => {
    if (sistema.modo !== "manual") {
        return res.status(400).json({
            erro: "Controle manual indisponível."
        });
    }

    if (typeof req.body.ligar !== "boolean") {
        return res.status(400).json({
            erro: "Estado da bomba inválido."
        });
    }

    if (req.body.ligar && sistema.nivel >= sistema.maximo) {
        return res.status(400).json({
            erro: "Limite máximo atingido."
        });
    }

    registrarAcionamento(req.body.ligar);

    res.json(sistema);
});

/* ALTERAR MODO */
app.post("/api/modo", (req, res) => {
    const modo = req.body.modo;

    if (modo !== "manual" && modo !== "automatico") {
        return res.status(400).json({
            erro: "Modo inválido."
        });
    }

    sistema.modo = modo;

    if (sistema.modo === "automatico") {
        controleAutomatico();
    }

    res.json(sistema);
});

/* CONFIGURAR LIMITES */
app.post("/api/limites", (req, res) => {
    const minimo = Number(req.body.minimo);
    const maximo = Number(req.body.maximo);

    if (minimo >= maximo) {
        return res.status(400).json({
            erro: "Limites inválidos."
        });
    }

    sistema.minimo = minimo;
    sistema.maximo = maximo;

    verificarNivelCritico();

    if (sistema.modo === "automatico") {
        controleAutomatico();
    }

    res.json(sistema);
});

/* INICIAR SERVIDOR */
app.listen(PORT, () => {
    console.log(`AquaLevel rodando em http://localhost:${PORT}`);
});