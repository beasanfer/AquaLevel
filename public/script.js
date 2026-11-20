/* Monitoramento do nível de água - AquaLevel */

/* ==================== VARIÁVEIS DE ESTADO ==================== */

let modo = "automatico";
let nivel = 0; // 0 até a primeira leitura do servidor
let litrosAtual = 0; // valor autoritativo vindo do servidor (dados.litros)
let bombaLigada = false; // false até a primeira leitura do servidor
let minimo = 30;
let maximo = 90;
let ultimaMedicaoDataHora = null;

/* Constantes espelhadas de base.ino — manter em sincronia com o firmware.
   ALTURA_RESERVATORIO_CM: distância sensor→fundo (tanque vazio).
   GAP_SENSOR_CM: distância mínima sensor↔água (tanque cheio).
   A altura útil (curso da água do vazio ao cheio) é a diferença.
   Estes valores DEVEM coincidir com os do base.ino — o firmware é a
   verdade operacional (é ele que fecha/abre o relé com base nesses
   números), e o dashboard apenas reflete a mesma conta. */
const ALTURA_RESERVATORIO_CM = 23.6;
const GAP_SENSOR_CM = 5.0;
const ALTURA_UTIL_CM = ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM;

/* Capacidade do reservatório — descoberta na primeira leitura válida
   (litros / (nivel/100)) e cacheada para permanecer exibida mesmo
   quando o nível cair a 0 momentaneamente. */
let capacidadeLitrosConhecida = null;

/* ==================== ELEMENTOS HTML ==================== */

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

/* Capacidade total e altura da água — preenchidos dinamicamente */
const capacidadeEl = document.getElementById("capacidadeLitros");
const alturaEl = document.getElementById("altura");

/* Elementos da página Configurações */
const minimoConfiguracao = document.getElementById("minimoConfiguracao");
const maximoConfiguracao = document.getElementById("maximoConfiguracao");
const modoConfiguracao = document.getElementById("modoConfiguracao");

/* Banda de operação (diferença entre máximo e mínimo) */
const bandaValue = document.getElementById("bandaValue");
const bandaConfiguracao = document.getElementById("bandaConfiguracao");

/* Aviso de falha do sensor */
const sensorBanner = document.getElementById("sensorBanner");

/* ==================== ACESSIBILIDADE ==================== */

const diminuirFonte = document.getElementById("diminuirFonte");
const aumentarFonte = document.getElementById("aumentarFonte");
const alternarContraste = document.getElementById("alternarContraste");

let tamanhoFonte = Number(localStorage.getItem("aqualevelFonte")) || 100;

let contrasteAtivo = localStorage.getItem("aqualevelContraste") === "true";

/* Aplica tamanho de fonte e alto contraste a partir do estado em memória,
   sincronizando localStorage, atributos ARIA e classes do body. */
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

/* ==================== NAVEGAÇÃO (SPA) ==================== */

const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");

/* Troca de página: alterna .active-page no <main> alvo e .active no link,
   e dispara cargas específicas de cada página (histórico, alertas,
   configurações, dashboard, relatórios). */
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

/* ==================== INDICADOR DE CONEXÃO ==================== */
/* Reflete o estado real da conexão no topo:
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

/* ==================== ATUALIZAR INTERFACE ==================== */

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

  // Última medição vem do timestamp da última leitura válida recebida
  // pelo backend. Atualização da interface é um relógio separado.
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

  /* Página Configurações */

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

/* ==================== FORMATAÇÃO DE ESTATÍSTICAS ==================== */

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

/* ==================== ESTATÍSTICAS (dashboard + relatórios) ==================== */

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

    /* Widgets do dashboard (bloco "HISTÓRICO DO NÍVEL") */
    set("statsNivelMedio", formatarPercentual(stats.nivelMedio));
    set("statsNivelMaximo", formatarPercentual(stats.nivelMaximo));
    set("statsNivelMinimo", formatarPercentual(stats.nivelMinimo));
    set("statsConsumo", formatarLitros(stats.consumoEstimado));

    /* Página Relatórios */
    set("reportNivelMedio", formatarPercentual(stats.nivelMedio));
    set("reportNivelMaximo", formatarPercentual(stats.nivelMaximo));
    set("reportNivelMinimo", formatarPercentual(stats.nivelMinimo));
    set("reportAcionamentos", formatarNumero(stats.acionamentos));
  } catch (erro) {
    console.error("Erro ao carregar estatísticas:", erro);
  }
}

/* ==================== LIGAR BOMBA ==================== */

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

/* ==================== DESLIGAR BOMBA ==================== */

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

/* ==================== MODO AUTOMÁTICO ==================== */

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

/* ==================== MODO MANUAL ==================== */

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

/* ==================== MOSTRAR LIMITES (sliders) ==================== */

inputMin.addEventListener("input", () => {
  minValue.textContent = inputMin.value;
});

inputMax.addEventListener("input", () => {
  maxValue.textContent = inputMax.value;
});

/* ==================== BLUR ROBUSTO DOS SLIDERS ====================
 * Objetivo: eliminar a janela em que o slider arrastado diverge do
 * valor autoritativo (minimo/maximo) por até 5s, SEM quebrar o fluxo
 * de "Salvar limites".
 *
 * Desafio: `blur` do slider dispara ANTES do `click` do botão Salvar.
 * Se resetarmos incondicionalmente no blur, o click leria o valor
 * recém-resetado (antigo) e o usuário perderia a mudança.
 *
 * Estratégia em quatro camadas:
 *
 * 1. Flag `salvarLimitesPendente`: setada no `mousedown` ou no
 *    `keydown` Enter/Espaço do botão Salvar. Como mousedown/keydown
 *    disparam ANTES do blur, o flag já está true quando o blur roda.
 *
 * 2. Checagem de `e.relatedTarget` no blur: se o foco está indo para
 *    o próprio botão Salvar (ex.: navegação por Tab + Enter), pula o
 *    reset. Cobre o caminho de teclado puro.
 *
 * 3. Blur forçado via listener de mousedown no documento: cobre o
 *    caso de clique em área não-focável (ex.: espaço vazio do card).
 *    Sem isso, o slider mantém o foco (o polling pula a sincronização
 *    porque activeElement === slider) e o valor arrastado persiste
 *    indefinidamente.
 *
 * 4. Reset da flag no `mouseup` global: cobre o cenário em que o
 *    usuário dá mousedown no botão Salvar, arrasta o mouse para fora
 *    antes de soltar (sem gerar click). Sem este reset, a flag
 *    permaneceria true indefinidamente, e o próximo blur de slider
 *    pularia o reset indevidamente. O mouseup precede o click no
 *    fluxo normal, então a flag está false no click handler — mas o
 *    click handler não depende da flag, só lê input.value.
 * ================================================================ */
let salvarLimitesPendente = false;

salvarLimites.addEventListener("mousedown", () => {
  salvarLimitesPendente = true;
});

salvarLimites.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    salvarLimitesPendente = true;
  }
});

/* Reset global no mouseup: o fluxo de click é
   mousedown → blur (skip via flag) → mouseup → click.
   Limpar aqui garante que, se o usuário abortou o clique (drag-out),
   a flag não fique presa — o próximo blur voltará a resetar. Se o
   usuário completou o clique, o handler de click já terá rodado
   (lendo input.value antes de qualquer efeito desta limpeza). */
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

/* Força o blur dos sliders quando o usuário clica fora deles e fora
   do botão Salvar. Sem isso, cliques em áreas não-focáveis não
   disparam blur nativo, e o slider ficaria "preso" com o valor
   arrastado (o polling não sincroniza enquanto o slider tem foco).

   Usa `salvarLimites.contains(e.target)` em vez de `===` para cobrir
   o caso em que o botão Salvar venha a ter elementos filhos (ícone,
   <span> etc.) — nesse cenário, `e.target` seria o filho, não o
   botão, e a comparação direta deixaria de funcionar. */
document.addEventListener("mousedown", (e) => {
  if (e.target === inputMin || e.target === inputMax) return;
  if (salvarLimites.contains(e.target)) return;
  if (document.activeElement === inputMin) inputMin.blur();
  if (document.activeElement === inputMax) inputMax.blur();
});

/* ==================== SALVAR LIMITES ==================== */

salvarLimites.addEventListener("click", async () => {
  const novoMinimo = Number(inputMin.value);
  const novoMaximo = Number(inputMax.value);

  /* Libera o flag para que blurs futuros voltem a resetar normalmente.
     Feito antes do await para não deixar o flag "vazado" durante a
     requisição. */
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

    /* Reflete imediatamente os novos valores (sliders + banda) sem
       esperar o próximo polling. */
    atualizarDashboard();

    alert("Limites atualizados.");
  } catch (erro) {
    console.error("Erro:", erro);
  }
});

/* ==================== GRÁFICO DE NÍVEL ==================== */

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

/* Atualiza o gráfico com as 20 medições mais recentes do histórico */
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

/* ==================== BUSCAR DADOS DO SERVIDOR ==================== */

async function buscarDados() {
  try {
    const resposta = await fetch("/api/status");

    if (!resposta.ok) {
      throw new Error("Erro ao buscar dados.");
    }

    const dados = await resposta.json();

    nivel = dados.nivel;
    ultimaMedicaoDataHora = dados.ultimaLeituraDataHora || null;
    /* Litros autoritativos vêm do servidor (calculados no ESP32 com
       CAPACIDADE_LITROS). Não assumimos mais "nivel * 10". */
    litrosAtual = Number(dados.litros) || 0;
    bombaLigada = dados.bombaLigada;
    minimo = dados.minimo;
    maximo = dados.maximo;
    modo = dados.modo;

    /* Exibe o banner quando o sensor reportou falha (sensorOK=false) */
    if (sensorBanner) {
      sensorBanner.classList.toggle("hidden", dados.sensorOK !== false);
    }

    /* Reflete o estado real no indicador do topo */
    atualizarIndicadorConexao(
      dados.sensorOK === false ? "sensor_falha" : "online",
    );

    atualizarDashboard();
  } catch (erro) {
    console.error("Erro de comunicação:", erro);
    /* Servidor inacessível — também atualiza o indicador do topo */
    atualizarIndicadorConexao("servidor_offline");
  }
}

/* ==================== ATUALIZAÇÃO AUTOMÁTICA ==================== */

setInterval(() => {
  buscarDados();

  atualizarGrafico();

  buscarUltimosEventos();

  buscarEstatisticas();

  buscarAlertas();
}, 5000);

/* ==================== CHAMADAS INICIAIS ==================== */
/* Disparam a primeira carga de dados; o hoisting de function declarations
   permite referenciar funções definidas mais abaixo. */

buscarDados();
atualizarGrafico();
buscarUltimosEventos();
buscarEstatisticas();

/* ==================== HISTÓRICO DE MEDIÇÕES ==================== */

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

/* ==================== CHAMADA INICIAL DO HISTÓRICO ==================== */

buscarHistorico();

/* ==================== ALERTAS ==================== */

/* Renderiza um alerta como HTML. `mostrarData` controla se data/hora
   aparecem (página Alertas) ou não (widget compacto do dashboard). */
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

/* ==================== CHAMADA INICIAL DOS ALERTAS ==================== */

buscarAlertas();

/* ==================== ÚLTIMOS EVENTOS DA BOMBA ==================== */

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

    /* Ordena do mais recente para o mais antigo e exibe os 5 últimos */
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
