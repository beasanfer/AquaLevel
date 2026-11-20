/* AquaLevel: estado da interface, consulta à API e comandos do usuário. */

/* ESTADO DA INTERFACE, SINCRONIZADO COM A API */

let modo = "automatico";
let nivel = 0; // valor inicial até o primeiro polling
let litrosAtual = 0; // volume informado pelo backend
let bombaLigada = false; // valor inicial até o primeiro polling
let minimo = 30;
let maximo = 90;
let ultimaMedicaoDataHora = null;

/* GEOMETRIA DO RESERVATÓRIO
 * As distâncias devem acompanhar os valores de base.ino para que
 * a altura exibida seja coerente com o nível calculado pelo firmware. */
const ALTURA_RESERVATORIO_CM = 23.6;
const GAP_SENSOR_CM = 5.0;
const ALTURA_UTIL_CM = ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM;

/* A capacidade é inferida por litros / (nível / 100) quando os dados
 * são positivos. O último valor obtido é preservado ao chegar a zero. */
let capacidadeLitrosConhecida = null;

/* REFERÊNCIAS A ELEMENTOS DO DOM */

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

/* Indicadores derivados da medição. */
const capacidadeEl = document.getElementById("capacidadeLitros");
const alturaEl = document.getElementById("altura");

/* Valores exibidos na página Configurações. */
const minimoConfiguracao = document.getElementById("minimoConfiguracao");
const maximoConfiguracao = document.getElementById("maximoConfiguracao");
const modoConfiguracao = document.getElementById("modoConfiguracao");

/* Banda de histerese exibida nas duas páginas. */
const bandaValue = document.getElementById("bandaValue");
const bandaConfiguracao = document.getElementById("bandaConfiguracao");

/* Banner de falha de sensor. */
const sensorBanner = document.getElementById("sensorBanner");

/* ACESSIBILIDADE: FONTES E CONTRASTE */

const diminuirFonte = document.getElementById("diminuirFonte");
const aumentarFonte = document.getElementById("aumentarFonte");
const alternarContraste = document.getElementById("alternarContraste");

let tamanhoFonte = Number(localStorage.getItem("aqualevelFonte")) || 100;

let contrasteAtivo = localStorage.getItem("aqualevelContraste") === "true";

/* Aplica preferências carregadas de localStorage à página,
 * incluindo classes e atributo aria-pressed do controle de contraste. */
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

/* NAVEGAÇÃO SPA: EXIBE UMA PÁGINA POR VEZ */

const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");

/* Alterna active-page/active e busca dados específicos ao navegar. */
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
      buscarEstatisticas();
    }

    if (pageId === "relatorios") {
      buscarEstatisticas();
    }

    window.scrollTo(0, 0);
  });
});

/* INDICADOR DO ESTADO DE COMUNICAÇÃO */
/* INDICADOR DE CONEXÃO
 * online: a API respondeu e sensorOK não é false.
 * sensor_falha: a API respondeu, mas sensorOK=false.
 * servidor_offline: a consulta à API falhou. */
function atualizarIndicadorConexao(estado) {
  const wifiStatusEl = document.getElementById("wifiStatus");
  if (!wifiStatusEl) return;
  // O status secundário é o elemento seguinte ao identificador wifiStatus.
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

/* RENDERIZAÇÃO DO DASHBOARD */

function atualizarDashboard() {
  percentual.textContent = nivel + "%";
  litros.textContent = Math.round(litrosAtual) + " litros";
  agua.style.height = nivel + "%";

  /* A cada leitura com volume e percentual positivos, recalcula a
   * capacidade. Fora dessa condição, conserva o último valor conhecido. */
  if (nivel > 0 && litrosAtual > 0) {
    capacidadeLitrosConhecida = Math.round((litrosAtual * 100) / nivel);
  }
  if (capacidadeEl) {
    capacidadeEl.textContent =
      capacidadeLitrosConhecida !== null
        ? capacidadeLitrosConhecida + " litros"
        : "-- litros";
  }

  /* A altura da água é proporcional ao curso útil do sensor, sem GAP. */
  if (alturaEl) {
    alturaEl.textContent = ((nivel / 100) * ALTURA_UTIL_CM).toFixed(1) + " cm";
  }

  bombaStatus.textContent = bombaLigada ? "Ligada" : "Desligada";
  bombaStatus.style.color = bombaLigada ? "#27a355" : "#ef4040";

  // Distingue o horário da última medição do horário do redesenho.
  const ultimaMedicaoData = ultimaMedicaoDataHora
    ? new Date(ultimaMedicaoDataHora)
    : null;
  ultimaMedicao.textContent =
    ultimaMedicaoData && !Number.isNaN(ultimaMedicaoData.getTime())
      ? ultimaMedicaoData.toLocaleTimeString("pt-BR")
      : "--:--:--";
  horaAtualizacao.textContent = new Date().toLocaleTimeString("pt-BR");

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

  /* Atualiza também os valores informativos em Configurações. */

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

  /* Histerese automática: liga abaixo do mínimo, desliga acima do
   * máximo e mantém o estado na faixa entre os dois limiares. */
  const banda = Math.max(0, maximo - minimo);

  if (bandaValue) {
    bandaValue.textContent = Math.round(banda);
  }

  if (bandaConfiguracao) {
    bandaConfiguracao.textContent = Math.round(banda) + "%";
  }

  /* Não atualiza sliders focados durante o polling para evitar
   * sobrescrever valores ainda em edição. */
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

/* FORMATAÇÃO DE DADOS E UNIDADES */

function formatarPercentual(valor) {
  return valor !== null && valor !== undefined ? Math.round(valor) + "%" : "--";
}

function formatarLitros(valor) {
  return valor !== null && valor !== undefined
    ? Math.round(valor) + " litros"
    : "--";
}

function formatarNumero(valor) {
  return valor !== null && valor !== undefined ? String(valor) : "--";
}

/* ESTATÍSTICAS DO DASHBOARD E DA PÁGINA RELATÓRIOS */

async function buscarEstatisticas() {
  try {
    const resposta = await fetch("/api/estatisticas");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar estatísticas.");
    }

    const stats = await resposta.json();

    const set = (id, valor) => {
      const el = document.getElementById(id);
      if (el) el.textContent = valor;
    };

    /* Preenche os indicadores resumidos do dashboard. */
    set("statsNivelMedio", formatarPercentual(stats.nivelMedio));
    set("statsNivelMaximo", formatarPercentual(stats.nivelMaximo));
    set("statsNivelMinimo", formatarPercentual(stats.nivelMinimo));
    set("statsConsumo", formatarLitros(stats.consumoEstimado));

    /* Preenche os indicadores da página Relatórios. */
    set("reportNivelMedio", formatarPercentual(stats.nivelMedio));
    set("reportNivelMaximo", formatarPercentual(stats.nivelMaximo));
    set("reportNivelMinimo", formatarPercentual(stats.nivelMinimo));
    set("reportAcionamentos", formatarNumero(stats.acionamentos));
  } catch (erro) {
    console.error("Erro ao carregar estatísticas:", erro);
  }
}

/* COMANDO MANUAL: LIGAR BOMBA */

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

/* COMANDO MANUAL: DESLIGAR BOMBA */

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

/* SELEÇÃO DO MODO AUTOMÁTICO */

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

/* SELEÇÃO DO MODO MANUAL */

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

/* ATUALIZAÇÃO VISUAL DOS SLIDERS */

inputMin.addEventListener("input", () => {
  minValue.textContent = inputMin.value;
});

inputMax.addEventListener("input", () => {
  maxValue.textContent = inputMax.value;
});

/* TRATAMENTO DE FOCO DOS SLIDERS
 * Ao perder o foco, o slider retorna ao valor confirmado, exceto
 * quando o usuário está iniciando um clique em Salvar. A flag é
 * marcada no mousedown/keydown; relatedTarget reconhece o botão.
 * Clicar fora força o blur e mouseup limpa a flag mesmo se um clique
 * for cancelado. O click de Salvar lê diretamente os valores atuais. */
let salvarLimitesPendente = false;

salvarLimites.addEventListener("mousedown", () => {
  salvarLimitesPendente = true;
});

salvarLimites.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    salvarLimitesPendente = true;
  }
});

/* O mouseup vem antes do click; limpar a flag evita que uma
 * tentativa de clique cancelada bloqueie restaurações futuras. */
document.addEventListener("mouseup", () => {
  salvarLimitesPendente = false;
});

function resetarSliderSeAplicavel(input, valorAutoritativo, spanValue, e) {
  if (salvarLimitesPendente) return;
  if (e && e.relatedTarget === salvarLimites) return;
  input.value = valorAutoritativo;
  spanValue.textContent = valorAutoritativo;
}

inputMin.addEventListener("blur", (e) => {
  resetarSliderSeAplicavel(inputMin, minimo, minValue, e);
});

inputMax.addEventListener("blur", (e) => {
  resetarSliderSeAplicavel(inputMax, maximo, maxValue, e);
});

/* Força a perda de foco ao clicar fora dos sliders e do botão
 * Salvar. contains() também considera cliques em filhos desse botão. */
document.addEventListener("mousedown", (e) => {
  if (e.target === inputMin || e.target === inputMax) return;
  if (salvarLimites.contains(e.target)) return;
  if (document.activeElement === inputMin) inputMin.blur();
  if (document.activeElement === inputMax) inputMax.blur();
});

/* ENVIO DOS LIMITES AO BACKEND */

salvarLimites.addEventListener("click", async () => {
  const novoMinimo = Number(inputMin.value);
  const novoMaximo = Number(inputMax.value);

  /* Restaura o comportamento normal de blur antes da requisição. */
  salvarLimitesPendente = false;

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

    /* Reflete os valores salvos sem esperar pelo próximo polling. */
    atualizarDashboard();

    alert("Limites atualizados.");
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* GRÁFICO DO NÍVEL (CHART.JS) */

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

/* Consulta e exibe até 20 registros recentes de nível. */
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

/* ATUALIZAÇÃO DO ESTADO VIA /api/status */

async function buscarDados() {
  try {
    const resposta = await fetch("/api/status");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar dados.");
    }

    const dados = await resposta.json();

    nivel = dados.nivel;
    ultimaMedicaoDataHora = dados.ultimaLeituraDataHora || null;
    /* Utiliza o volume calculado pelo firmware e repassado pela API. */
    litrosAtual = Number(dados.litros) || 0;
    bombaLigada = dados.bombaLigada;
    minimo = dados.minimo;
    maximo = dados.maximo;
    modo = dados.modo;

    /* Sensor com falha ou ESP32 sem comunicação: mostra o aviso. */
    if (sensorBanner) {
      sensorBanner.classList.toggle("hidden", dados.sensorOK !== false);
    }

    /* Diferencia falha do sensor de falha na consulta ao servidor. */
    atualizarIndicadorConexao(
      dados.sensorOK === false ? "sensor_falha" : "online",
    );

    atualizarDashboard();
  } catch (erro) {
    console.error("Erro de comunicação:", erro);
    /* Se a consulta falhar, mostra o estado de servidor offline. */
    atualizarIndicadorConexao("servidor_offline");
  }
}

/* POLLING DE STATUS, HISTÓRICOS E ALERTAS A CADA 5 s */

setInterval(() => {
  buscarDados();

  atualizarGrafico();

  buscarUltimosEventos();

  buscarEstatisticas();

  buscarAlertas();
}, 5000);

/* CARGA INICIAL
 * Declarações de função podem ser chamadas antes de sua posição no
 * arquivo devido ao hoisting do JavaScript. */
/* Disparam a primeira carga de dados; o hoisting de function declarations
   permite referenciar funções definidas mais abaixo. */

buscarDados();
atualizarGrafico();
buscarUltimosEventos();
buscarEstatisticas();

/* HISTÓRICO DE MEDIÇÕES: CONSTRUÇÃO DA TABELA */

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

/* Carrega a tabela de medições ao abrir a aplicação. */

buscarHistorico();

/* ALERTAS ATIVOS E HISTÓRICO */

/* Gera o HTML de um alerta, com data apenas na visualização detalhada. */
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
    const [respostaAtivos, respostaHistorico] = await Promise.all([
      fetch("/api/alertas/ativos"),
      fetch("/api/alertas"),
    ]);

    if (!respostaAtivos.ok || !respostaHistorico.ok) {
      throw new Error("Erro ao buscar alertas.");
    }

    const alertasAtivos = await respostaAtivos.json();
    const historicoAlertas = await respostaHistorico.json();

    if (listaAlertas) listaAlertas.innerHTML = "";
    if (alertasDashboard) alertasDashboard.innerHTML = "";

    if (listaAlertas) {
      listaAlertas.innerHTML = "<h4>Alertas ativos</h4>";
      if (alertasAtivos.length === 0) {
        listaAlertas.innerHTML += "<p>Nenhum alerta ativo.</p>";
      } else {
        alertasAtivos
          .slice()
          .reverse()
          .forEach((alerta) => {
            listaAlertas.innerHTML += criarAlertaHTML(alerta, true);
          });
      }

      listaAlertas.innerHTML +=
        '<h4 class="alert-history-title">Histórico de alertas</h4>';
      if (historicoAlertas.length === 0) {
        listaAlertas.innerHTML += "<p>Nenhum alerta registrado.</p>";
      } else {
        historicoAlertas
          .slice()
          .reverse()
          .forEach((alerta) => {
            listaAlertas.innerHTML += criarAlertaHTML(alerta, true);
          });
      }
    }

    if (alertasDashboard) {
      if (alertasAtivos.length === 0) {
        alertasDashboard.innerHTML = "<p>Nenhum alerta ativo.</p>";
      } else {
        alertasAtivos
          .slice()
          .reverse()
          .slice(0, 2)
          .forEach((alerta) => {
            alertasDashboard.innerHTML += criarAlertaHTML(alerta, false);
          });
      }
    }
  } catch (erro) {
    console.error("Erro ao carregar alertas:", erro);
    if (listaAlertas)
      listaAlertas.innerHTML = "<p>Erro ao carregar os alertas.</p>";
    if (alertasDashboard)
      alertasDashboard.innerHTML = "<p>Erro ao carregar os alertas.</p>";
  }
}

/* Carrega os alertas na inicialização. */

buscarAlertas();

/* ÚLTIMOS ACIONAMENTOS DA BOMBA */

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

    /* Exibe as cinco transições mais recentes em ordem decrescente de data. */
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
