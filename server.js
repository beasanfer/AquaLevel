const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
    express.static("public")
);

let sistema = {
    nivel: 72,
    litros: 720,
    bombaLigada: true,
    modo: "automatico",
    minimo: 30,
    maximo: 90,
    sensorOK: true
};

/* ESP32 ENVIA LEITURA */
app.post(
    "/api/nivel",
    (req, res) => {
        sistema.nivel =
            req.body.nivel;
        sistema.litros =
            req.body.litros;

        /* PROTEÇÃO */
        if (
            sistema.nivel >=
            sistema.maximo
        ) {
            sistema.bombaLigada =
                false;
        }

        /* MODO AUTOMÁTICO */
        if (
            sistema.modo ===
            "automatico"
        ) {
            if (
                sistema.nivel <=
                sistema.minimo
            ) {
                sistema.bombaLigada =
                    true;
            }
        }

        res.json({
            sucesso: true
        });
    }
);

/* DASHBOARD CONSULTA */
app.get(
    "/api/status",
    (req, res) => {
        res.json(sistema);
    }
);

/* ALTERAR BOMBA */
app.post(
    "/api/bomba",
    (req, res) => {
        if (
            sistema.modo !==
            "manual"
        ) {
            return res.status(400)
            .json({
                erro:
                "Controle manual indisponível."
            });
        }

        if (
            req.body.ligar &&
            sistema.nivel >=
            sistema.maximo
        ) {
            return res.status(400)
            .json({
                erro:
                "Limite máximo atingido."
            });
        }

        sistema.bombaLigada =
            req.body.ligar;
        res.json(sistema);
    }
);

/* ALTERAR MODO */
app.post(
    "/api/modo",
    (req, res) => {
        sistema.modo =
            req.body.modo;
        res.json(sistema);
    }
);

/* CONFIGURAR LIMITES */
app.post(
    "/api/limites",
    (req, res) => {
        const minimo =
            Number(req.body.minimo);
        const maximo =
            Number(req.body.maximo);
        if (minimo >= maximo) {
            return res
            .status(400)
            .json({
                erro:
                "Limites inválidos."
            });
        }

        sistema.minimo =
            minimo;
        sistema.maximo =
            maximo;
        res.json(sistema);
    }
);

app.listen(
    PORT,
    () => {
        console.log(
            `AquaLevel rodando em http://localhost:${PORT}`
        );
    }
);