/* Monitoramento do nível de água - AquaLevel */

/* 1. VARIÁVEIS */

let modo = "automatico";
let nivel = 72;
let litrosAtual = 720; // valor autoritativo vindo do servidor (dados.litros)
let bombaLigada = true;
let minimo = 30;
let maximo = 90;

/* Constantes espelhadas de rest.ino — manter em sincronia com o firmware.
   ALTURA_RESERVATORIO_CM: distância sensor→fundo (tanque vazio).
   GAP_SENSOR_CM: distância mínima sensor↔água (tanque cheio).
   A altura útil (curso da água do vazio ao cheio) é a diferença. */
const ALTURA_RESERVATORIO_CM = 22.5;
const GAP_SENSOR_CM = 5.0;
const ALTURA_UTIL_CM = ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM;

/* Capacidade do reservatório — descoberta na primeira leitura válida
   (litros / (nivel/100)) e cacheada para permanecer exibida mesmo
   quando o nível cair a 0 momentaneamente. */
let capacidadeLitrosConhecida = null;

/* 2. ELEMENTOS HTML */

const percentual = document.getElementById("percentual");
const litros = document.getElementById("litros");
const agua = document.getElementById("agua");
const bombaStatus = document.getElementById("bombaStatus");
const ultimaMedicao = document.getElementById("ultimaMedicao");
const horaAtualizacao = document.getElementById("horaAtualizacao");
const btnAutomatico = document.getElementById("btnAutomatico");
const btnManual = document.getElementById("btnManual");
const ligarBomba = document.getElementById("ligarBomba");
const desligarBomba = document.getElementById("desligarBomba");
const inputMin = document.getElementById("minimo");
const inputMax = document.getElementById("maximo");
const minValue = document.getElementById("minValue");
const maxValue = document.getElementById("maxValue");
const salvarLimites = document.getElementById("salvarLimites");
const tabelaHistorico = document.getElementById("tabelaHistorico");
const listaAlertas = document.getElementById("listaAlertas");
const alertasDashboard = document.getElementById("alertas");
const eventosDashboard = document.getElementById("eventos");

/* Campos antes estáticos (bug de UI): capacidade total e altura da água */
const capacidadeEl = document.getElementById("capacidadeLitros");
const alturaEl = document.getElementById("altura");

/* ISSUE #23 */

const minimoConfiguracao = document.getElementById("minimoConfiguracao");
const maximoConfiguracao = document.getElementById("maximoConfiguracao");
const modoConfiguracao = document.getElementById("modoConfiguracao");

/* Banda de operação (substitui a antiga "Histerese 5%" fixa) */
const bandaValue = document.getElementById("bandaValue");
const bandaConfiguracao = document.getElementById("bandaConfiguracao");

/* Aviso de falha do sensor */
const sensorBanner = document.getElementById("sensorBanner");

/* ACESSIBILIDADE */

const diminuirFonte = document.getElementById("diminuirFonte");
const aumentarFonte = document.getElementById("aumentarFonte");
const alternarContraste = document.getElementById("alternarContraste");

let tamanhoFonte = Number(localStorage.getItem("aqualevelFonte")) || 100;

let contrasteAtivo = localStorage.getItem("aqualevelContraste") === "true";

function aplicarAcessibilidade() {
  document.documentElement.style.fontSize = tamanhoFonte + "%";

  document.body.classList.toggle("alto-contraste", contrasteAtivo);

  alternarContraste.setAttribute("aria-pressed", String(contrasteAtivo));

  alternarContraste.classList.toggle("ativo", contrasteAtivo);

  alternarContraste.title = contrasteAtivo
    ? "Desativar alto contraste"
    : "Ativar alto contraste";
}

diminuirFonte.addEventListener("click", () => {
  tamanhoFonte = Math.max(85, tamanhoFonte - 10);

  localStorage.setItem("aqualevelFonte", tamanhoFonte);

  aplicarAcessibilidade();
});

aumentarFonte.addEventListener("click", () => {
  tamanhoFonte = Math.min(130, tamanhoFonte + 10);

  localStorage.setItem("aqualevelFonte", tamanhoFonte);

  aplicarAcessibilidade();
});

alternarContraste.addEventListener("click", () => {
  contrasteAtivo = !contrasteAtivo;

  localStorage.setItem("aqualevelContraste", String(contrasteAtivo));

  aplicarAcessibilidade();
});

aplicarAcessibilidade();

/* 3. NAVEGAÇÃO */

const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    const pageId = link.dataset.page;

    pages.forEach((page) => {
      page.classList.remove("active-page");
    });

    navLinks.forEach((item) => {
      item.classList.remove("active");
    });

    document.getElementById(pageId).classList.add("active-page");
    link.classList.add("active");

    if (pageId === "historico") {
      buscarHistorico();
    }

    if (pageId === "alertas-page") {
      buscarAlertas();
    }

    if (pageId === "configuracoes") {
      buscarDados();
    }

    if (pageId === "dashboard") {
      atualizarGrafico();
      buscarUltimosEventos();
    }

    window.scrollTo(0, 0);
  });
});

/* 3.2: indicador de conexão do topo — deixa de ser hardcoded.
 * Estados:
 *   - "online"           → servidor ok, ESP32 reportando, sensor ok
 *   - "sensor_falha"     → servidor responde, mas sensorOK=false
 *                          (falha do HC-SR04 ou ESP32 silencioso)
 *   - "servidor_offline" → fetch de /api/status falhou
 */
function atualizarIndicadorConexao(estado) {
  const wifiStatusEl = document.getElementById("wifiStatus");
  if (!wifiStatusEl) return;
  // <span> é o irmão imediato de #wifiStatus dentro de .connection
  const espStatusEl = wifiStatusEl.nextElementSibling;

  if (estado === "online") {
    wifiStatusEl.textContent = "● Conectado";
    wifiStatusEl.style.color = "#68c989";
    if (espStatusEl) espStatusEl.textContent = "ESP32 • Online";
  } else if (estado === "sensor_falha") {
    wifiStatusEl.textContent = "● Sensor com falha";
    wifiStatusEl.style.color = "#ffd600";
    if (espStatusEl) espStatusEl.textContent = "ESP32 • Atenção";
  } else {
    wifiStatusEl.textContent = "● Sem conexão";
    wifiStatusEl.style.color = "#ef4040";
    if (espStatusEl) espStatusEl.textContent = "Servidor • Offline";
  }
}

/* 4. ATUALIZAR INTERFACE */

function atualizarDashboard() {
  percentual.textContent = nivel + "%";
  litros.textContent = Math.round(litrosAtual) + " litros";
  agua.style.height = nivel + "%";

  /* Capacidade total do reservatório — derivada de litros/(nivel/100)
     na primeira leitura válida e cacheada. O servidor só expõe nivel e
     litros; a relação litros = nivel × CAPACIDADE / 100 permite
     recuperar a capacidade exata. */
  if (nivel > 0 && litrosAtual > 0) {
    capacidadeLitrosConhecida = Math.round((litrosAtual * 100) / nivel);
  }
  if (capacidadeEl) {
    capacidadeEl.textContent =
      capacidadeLitrosConhecida !== null
        ? capacidadeLitrosConhecida + " litros"
        : "-- litros";
  }

  /* Altura da coluna de água (cm) — proporcional ao curso útil do sensor
     (ALTURA_UTIL_CM = ALTURA_RESERVATORIO_CM − GAP_SENSOR_CM). */
  if (alturaEl) {
    alturaEl.textContent = ((nivel / 100) * ALTURA_UTIL_CM).toFixed(1) + " cm";
  }

  bombaStatus.textContent = bombaLigada ? "Ligada" : "Desligada";
  bombaStatus.style.color = bombaLigada ? "#27a355" : "#ef4040";

  const agora = new Date().toLocaleTimeString();

  ultimaMedicao.textContent = agora;
  horaAtualizacao.textContent = agora;

  const nivelStatus = document.getElementById("nivelStatus");

  if (nivel < minimo) {
    nivelStatus.textContent = "Nível crítico";
    nivelStatus.parentElement.style.color = "#c92d2d";
  } else if (nivel >= maximo) {
    nivelStatus.textContent = "Nível máximo";
    nivelStatus.parentElement.style.color = "#0877e8";
  } else {
    nivelStatus.textContent = "Nível normal";
    nivelStatus.parentElement.style.color = "#29a45d";
  }

  if (modo === "automatico") {
    btnAutomatico.classList.add("active-mode");
    btnManual.classList.remove("active-mode");
  } else {
    btnManual.classList.add("active-mode");
    btnAutomatico.classList.remove("active-mode");
  }

  const acionamentoBomba = document.getElementById("acionamentoBomba");

  if (acionamentoBomba) {
    acionamentoBomba.textContent =
      modo === "automatico" ? "Automático" : "Manual";
  }

  /* ISSUE #23 - CONFIGURAÇÕES */

  if (minimoConfiguracao) {
    minimoConfiguracao.textContent = minimo + "%";
  }

  if (maximoConfiguracao) {
    maximoConfiguracao.textContent = maximo + "%";
  }

  if (modoConfiguracao) {
    modoConfiguracao.textContent =
      modo === "automatico" ? "Automático" : "Manual";
  }

  /* Banda de operação = diferença entre máximo e mínimo.
     Reflete o comportamento REAL do sistema:
       - bomba liga quando nível < mínimo
       - bomba desliga quando nível > máximo
       - entre mínimo e máximo, a bomba mantém o estado (banda morta) */
  const banda = Math.max(0, maximo - minimo);

  if (bandaValue) {
    bandaValue.textContent = Math.round(banda);
  }

  if (bandaConfiguracao) {
    bandaConfiguracao.textContent = Math.round(banda) + "%";
  }

  /* Sliders: só sobrescreve se o usuário NÃO estiver interagindo.
     Evita que o polling de 5s reverta o valor enquanto o slider está
     em foco (drag em andamento). */
  if (document.activeElement !== inputMin) {
    inputMin.value = minimo;
    minValue.textContent = minimo;
  }

  if (document.activeElement !== inputMax) {
    inputMax.value = maximo;
    maxValue.textContent = maximo;
  }

  ligarBomba.disabled = modo !== "manual";
  desligarBomba.disabled = modo !== "manual";
}

/* 5. LIGAR BOMBA */

ligarBomba.addEventListener("click", async () => {
  if (modo !== "manual") {
    alert("Controle disponível somente no modo manual.");
    return;
  }

  if (nivel >= maximo) {
    alert("A bomba não pode ser ligada. Limite máximo atingido.");

    return;
  }

  try {
    const resposta = await fetch("/api/bomba", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ligar: true,
      }),
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      alert(dados.erro || "Erro ao ligar a bomba.");

      return;
    }

    bombaLigada = true;
    atualizarDashboard();
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* 6. DESLIGAR BOMBA */

desligarBomba.addEventListener("click", async () => {
  if (modo !== "manual") {
    alert("Controle disponível somente no modo manual.");
    return;
  }

  try {
    const resposta = await fetch("/api/bomba", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ligar: false,
      }),
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      alert(dados.erro || "Erro ao desligar a bomba.");

      return;
    }

    bombaLigada = false;
    atualizarDashboard();
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* 7. MODO AUTOMÁTICO */

btnAutomatico.addEventListener("click", async () => {
  try {
    const resposta = await fetch("/api/modo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        modo: "automatico",
      }),
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      alert(dados.erro || "Erro ao alterar modo.");

      return;
    }

    modo = "automatico";
    atualizarDashboard();
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* 8. MODO MANUAL */

btnManual.addEventListener("click", async () => {
  try {
    const resposta = await fetch("/api/modo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        modo: "manual",
      }),
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      alert(dados.erro || "Erro ao alterar modo.");

      return;
    }

    modo = "manual";
    atualizarDashboard();
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* 9. MOSTRAR LIMITES */

inputMin.addEventListener("input", () => {
  minValue.textContent = inputMin.value;
});

inputMax.addEventListener("input", () => {
  maxValue.textContent = inputMax.value;
});

/* 10. SALVAR LIMITES */

salvarLimites.addEventListener("click", async () => {
  const novoMinimo = Number(inputMin.value);
  const novoMaximo = Number(inputMax.value);

  if (novoMinimo >= novoMaximo) {
    alert("O limite mínimo deve ser menor que o máximo.");

    return;
  }

  try {
    const resposta = await fetch("/api/limites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        minimo: novoMinimo,
        maximo: novoMaximo,
      }),
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      alert(dados.erro || "Erro ao salvar limites.");

      return;
    }

    minimo = novoMinimo;
    maximo = novoMaximo;

    /* Reflete imediatamente os novos valores (sliders + banda) sem
       esperar o próximo polling. */
    atualizarDashboard();

    alert("Limites atualizados.");
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* 11. GRÁFICO - ISSUE #25 */

const ctx = document.getElementById("graficoNivel");

const grafico = new Chart(ctx, {
  type: "line",

  data: {
    labels: [],

    datasets: [
      {
        label: "Nível da água (%)",
        data: [],
        borderColor: "#0877e8",
        tension: 0.3,
        fill: false,
      },
    ],
  },

  options: {
    responsive: true,

    scales: {
      y: {
        min: 0,
        max: 100,
      },
    },
  },
});

/* ATUALIZAR GRÁFICO COM O HISTÓRICO */

async function atualizarGrafico() {
  try {
    const resposta = await fetch("/api/historico");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar dados do gráfico.");
    }

    const historico = await resposta.json();

    if (historico.length === 0) {
      grafico.data.labels = [];
      grafico.data.datasets[0].data = [];

      grafico.update();

      return;
    }

    /* Exibe as 20 medições mais recentes */

    const registros = historico.slice(-20);

    const horarios = registros.map((registro) => {
      const dataHora = new Date(registro.dataHora);

      return dataHora.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    });

    const niveis = registros.map((registro) => Number(registro.nivel));

    grafico.data.labels = horarios;
    grafico.data.datasets[0].data = niveis;

    grafico.update();
  } catch (erro) {
    console.error("Erro ao atualizar gráfico:", erro);
  }
}

/* 12. BUSCAR DADOS DO SERVIDOR */

async function buscarDados() {
  try {
    const resposta = await fetch("/api/status");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar dados.");
    }

    const dados = await resposta.json();

    nivel = dados.nivel;
    /* Litros autoritativos vêm do servidor (calculados no ESP32 com
       CAPACIDADE_LITROS). Não assumimos mais "nivel * 10". */
    litrosAtual = Number(dados.litros) || 0;
    bombaLigada = dados.bombaLigada;
    minimo = dados.minimo;
    maximo = dados.maximo;
    modo = dados.modo;

    /* Item 6: exibe aviso quando o sensor reportou falha (sensorOK=false). */
    if (sensorBanner) {
      sensorBanner.classList.toggle("hidden", dados.sensorOK !== false);
    }

    /* 3.2: reflete o estado real no indicador do topo. */
    atualizarIndicadorConexao(
      dados.sensorOK === false ? "sensor_falha" : "online",
    );

    atualizarDashboard();
  } catch (erro) {
    console.error("Erro de comunicação:", erro);
    /* 3.2: servidor inacessível — também atualiza o topo. */
    atualizarIndicadorConexao("servidor_offline");
  }
}

/* 13. ATUALIZAÇÃO AUTOMÁTICA */

setInterval(() => {
  buscarDados();

  atualizarGrafico();

  buscarUltimosEventos();
}, 5000);

/* 14. PRIMEIRA BUSCA */

buscarDados();
atualizarGrafico();
buscarUltimosEventos();

/* 15. HISTÓRICO DE MEDIÇÕES - ISSUE #19 */

async function buscarHistorico() {
  if (!tabelaHistorico) {
    return;
  }

  try {
    const resposta = await fetch("/api/historico");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar histórico.");
    }

    const historico = await resposta.json();

    tabelaHistorico.innerHTML = "";

    if (historico.length === 0) {
      tabelaHistorico.innerHTML = `
                <tr>
                    <td colspan="6">
                        Nenhuma medição registrada.
                    </td>
                </tr>
            `;

      return;
    }

    historico
      .slice()
      .reverse()
      .forEach((registro) => {
        const dataHora = new Date(registro.dataHora);

        const data = dataHora.toLocaleDateString("pt-BR");

        const hora = dataHora.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        const bombaTexto =
          registro.bombaLigada === true
            ? "Ligada"
            : registro.bombaLigada === false
              ? "Desligada"
              : "-";

        const modoTexto =
          registro.modo === "automatico"
            ? "Automático"
            : registro.modo === "manual"
              ? "Manual"
              : "-";

        const linha = document.createElement("tr");

        linha.innerHTML = `
                    <td>${data}</td>
                    <td>${hora}</td>
                    <td>${registro.nivel}%</td>
                    <td>${registro.litros} L</td>
                    <td>${bombaTexto}</td>
                    <td>${modoTexto}</td>
                `;

        tabelaHistorico.appendChild(linha);
      });
  } catch (erro) {
    console.error("Erro ao carregar histórico:", erro);

    tabelaHistorico.innerHTML = `
            <tr>
                <td colspan="6">
                    Erro ao carregar o histórico.
                </td>
            </tr>
        `;
  }
}

/* 16. PRIMEIRA BUSCA DO HISTÓRICO */

buscarHistorico();

/* 17. ALERTAS - ISSUE #21 */

function criarAlertaHTML(alerta, mostrarData = false) {
  const dataHora = new Date(alerta.dataHora);

  const data = dataHora.toLocaleDateString("pt-BR");

  const hora = dataHora.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const titulo =
    alerta.tipo === "nivel_critico"
      ? "Nível crítico"
      : alerta.tipo === "corte_seguranca"
        ? "Corte de segurança"
        : alerta.tipo === "esp32_offline"
          ? "ESP32 offline"
          : alerta.tipo;

  const nivelTexto =
    alerta.nivel !== undefined ? ` Nível registrado: ${alerta.nivel}%.` : "";

  return `
        <div class="alert danger">
            ⚠
            <div>
                <strong>${titulo}</strong>
                <p>${alerta.mensagem}${nivelTexto}</p>
                ${mostrarData ? `<small>${data} • ${hora}</small>` : ""}
            </div>
        </div>
    `;
}

async function buscarAlertas() {
  try {
    const resposta = await fetch("/api/alertas");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar alertas.");
    }

    const alertas = await resposta.json();

    if (listaAlertas) {
      listaAlertas.innerHTML = "";
    }

    if (alertasDashboard) {
      alertasDashboard.innerHTML = "";
    }

    if (alertas.length === 0) {
      if (listaAlertas) {
        listaAlertas.innerHTML = "<p>Nenhum alerta registrado.</p>";
      }

      if (alertasDashboard) {
        alertasDashboard.innerHTML = "<p>Nenhum alerta ativo.</p>";
      }

      return;
    }

    const alertasOrdenados = alertas.slice().reverse();

    if (listaAlertas) {
      alertasOrdenados.forEach((alerta) => {
        listaAlertas.innerHTML += criarAlertaHTML(alerta, true);
      });
    }

    if (alertasDashboard) {
      alertasOrdenados.slice(0, 2).forEach((alerta) => {
        alertasDashboard.innerHTML += criarAlertaHTML(alerta, false);
      });
    }
  } catch (erro) {
    console.error("Erro ao carregar alertas:", erro);

    if (listaAlertas) {
      listaAlertas.innerHTML = "<p>Erro ao carregar os alertas.</p>";
    }

    if (alertasDashboard) {
      alertasDashboard.innerHTML = "<p>Erro ao carregar os alertas.</p>";
    }
  }
}

/* 18. PRIMEIRA BUSCA DOS ALERTAS */

buscarAlertas();

/* 19. ÚLTIMOS EVENTOS DA BOMBA - ISSUE #27 */

function criarEventoBombaHTML(evento) {
  const dataHora = new Date(evento.dataHora);

  const data = dataHora.toLocaleDateString("pt-BR");

  const hora = dataHora.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const estado =
    evento.estado === "ligada" ? "Bomba ligada" : "Bomba desligada";

  const icone = evento.estado === "ligada" ? "▶" : "■";

  const modoEvento = evento.modo === "automatico" ? "Automático" : "Manual";

  return `
        <div class="evento-bomba">
            <p>${icone} <strong>${estado}</strong></p>
            <small>${data} • ${hora} • Modo: ${modoEvento}</small>
        </div>
    `;
}

async function buscarUltimosEventos() {
  if (!eventosDashboard) {
    return;
  }

  try {
    const resposta = await fetch("/api/historico-bomba");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar histórico da bomba.");
    }

    const historicoBomba = await resposta.json();

    eventosDashboard.innerHTML = "";

    if (historicoBomba.length === 0) {
      eventosDashboard.innerHTML =
        "<p>Nenhum acionamento da bomba registrado.</p>";

      return;
    }

    const eventosOrdenados = historicoBomba
      .slice()
      .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));

    eventosOrdenados.slice(0, 5).forEach((evento) => {
      eventosDashboard.innerHTML += criarEventoBombaHTML(evento);
    });
  } catch (erro) {
    console.error("Erro ao carregar eventos da bomba:", erro);

    eventosDashboard.innerHTML = "<p>Erro ao carregar os eventos da bomba.</p>";
  }
}
