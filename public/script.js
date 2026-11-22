/**
 * AquaLevel | Interface e comunicação com a API
 *
 * Atualiza o dashboard, apresenta dados históricos e envia solicitações
 * de controle. As URLs relativas funcionam no localhost e no Render.
 */

// ===========================================================================
// 01. Estado da interface e parâmetros
// ===========================================================================

let modo = "automatico";
let nivel = 0; // valor inicial até o primeiro polling
let litrosAtual = 0; // volume informado pelo backend
// Estado lógico antigo preservado no backend; a UI exibe apenas confirmação.
let bombaConfirmada = null;
let bombaDesejada = false;
let comandoPendente = false;
// Uma requisição de ligar NÃO bloqueia o botão de desligar.
let ligamentoEmAndamento = false;
let desligamentoEmAndamento = false;
let alteracaoModoEmAndamento = false;
let salvamentoLimitesEmAndamento = false;
// Alterações locais invalidam apenas respostas de status iniciadas antes delas.
let revisaoEstadoLocal = 0;
let esp32Online = false;
let sensorOK = true;
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

// ===========================================================================
// 02. Elementos da interface
// ===========================================================================

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
const cancelarLimites = document.getElementById("cancelarLimites");
const bombaDescricao = document.getElementById("bombaDescricao");
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

// ===========================================================================
// 03. Acessibilidade
// ===========================================================================

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
  alternarContraste.title = contrasteAtivo ? "Desativar alto contraste" : "Ativar alto contraste";
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

// ===========================================================================
// 04. Navegação entre páginas
// ===========================================================================

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
      item.removeAttribute("aria-current");
    });

    document.getElementById(pageId).classList.add("active-page");
    link.classList.add("active");
    link.setAttribute("aria-current", "page");

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

// ===========================================================================
// 05. Indicadores de comunicação
// ===========================================================================
/* INDICADOR DE CONEXÃO
 * online: API respondeu, ESP32 online e sensorOK.
 * esp32_offline: API respondeu, mas ESP32 sem telemetria recente.
 * sensor_falha: ESP32 responde, porém não consegue medir.
 * servidor_offline: falhou a consulta à API. */
const INDICADORES_CONEXAO = {
  online: ["● Conectado", "#68c989", "ESP32 • Online"],
  sensor_falha: ["● Sensor com falha", "#ffd600", "ESP32 • Online (sem leitura)"],
  esp32_offline: ["● ESP32 offline", "#ef4040", "Servidor • Online"],
  servidor_offline: ["● Sem conexão", "#ef4040", "Servidor • Offline"],
};

function atualizarIndicadorConexao(estado) {
  const wifi = document.getElementById("wifiStatus");

  if (!wifi) return;

  const indicador = Object.hasOwn(INDICADORES_CONEXAO, estado)
    ? INDICADORES_CONEXAO[estado]
    : INDICADORES_CONEXAO.servidor_offline;
  const [texto, cor, detalhe] = indicador;

  wifi.textContent = texto;
  wifi.style.color = cor;

  if (wifi.nextElementSibling) wifi.nextElementSibling.textContent = detalhe;
}

// ===========================================================================
// 06. Renderização do dashboard
// ===========================================================================

function atualizarReservatorio() {
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
      capacidadeLitrosConhecida !== null ? capacidadeLitrosConhecida + " litros" : "-- litros";
  }
  /* A altura da água é proporcional ao curso útil do sensor, sem GAP. */
  if (alturaEl) {
    alturaEl.textContent = ((nivel / 100) * ALTURA_UTIL_CM).toFixed(1) + " cm";
  }
}

function atualizarBomba() {
  // Não apresentar a intenção de ligar como confirmação do relé físico.
  bombaStatus.textContent =
    bombaConfirmada === null ? "Sem confirmação" : bombaConfirmada ? "Ligada" : "Desligada";
  bombaStatus.style.color =
    bombaConfirmada === null ? "#59677a" : bombaConfirmada ? "#27a355" : "#ef4040";
  if (bombaDescricao) {
    if (!esp32Online) {
      bombaDescricao.textContent = "ESP32 offline: estado físico desconhecido.";
    } else if (comandoPendente) {
      bombaDescricao.textContent = `Solicitado: ${bombaDesejada ? "ligar" : "desligar"}. Aguardando confirmação do ESP32.`;
    } else if (!sensorOK) {
      bombaDescricao.textContent = "Sensor com falha. Verifique as conexões.";
    } else {
      bombaDescricao.textContent = "Estado informado pela última telemetria do ESP32.";
    }
  }
}

function atualizarMedicaoENivel() {
  // Distingue o horário da última medição do horário do redesenho.
  const ultimaMedicaoData = ultimaMedicaoDataHora ? new Date(ultimaMedicaoDataHora) : null;
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
}

function atualizarModo() {
  const automatico = modo === "automatico";
  btnAutomatico.classList.toggle("active-mode", automatico);
  btnManual.classList.toggle("active-mode", !automatico);

  const acionamentoBomba = document.getElementById("acionamentoBomba");

  if (acionamentoBomba) {
    acionamentoBomba.textContent = modo === "automatico" ? "Automático" : "Manual";
  }
  /* Atualiza também os valores informativos em Configurações. */
  if (minimoConfiguracao) {
    minimoConfiguracao.textContent = minimo + "%";
  }
  if (maximoConfiguracao) {
    maximoConfiguracao.textContent = maximo + "%";
  }
  if (modoConfiguracao) {
    modoConfiguracao.textContent = modo === "automatico" ? "Automático" : "Manual";
  }
}

function atualizarLimitesEControles() {
  /* Histerese automática: liga abaixo do mínimo, desliga acima do
   * máximo e mantém o estado na faixa entre os dois limiares. */
  const banda = limitesEmEdicao
    ? Math.max(0, limitesRascunho.maximo - limitesRascunho.minimo)
    : Math.max(0, maximo - minimo);

  if (bandaValue) {
    bandaValue.textContent = Math.round(banda);
  }
  if (bandaConfiguracao) {
    bandaConfiguracao.textContent = Math.round(banda) + "%";
  }
  // O rascunho é independente do foco: polling não apaga alterações.
  if (!limitesEmEdicao) {
    inputMin.value = minimo;
    inputMax.value = maximo;
    minValue.textContent = minimo;
    maxValue.textContent = maximo;
  }
  if (cancelarLimites) cancelarLimites.disabled = salvamentoLimitesEmAndamento || !limitesEmEdicao;
  salvarLimites.disabled = salvamentoLimitesEmAndamento;
  inputMin.disabled = salvamentoLimitesEmAndamento;
  inputMax.disabled = salvamentoLimitesEmAndamento;

  const controlesModoBloqueados =
    alteracaoModoEmAndamento || ligamentoEmAndamento || desligamentoEmAndamento;

  btnAutomatico.disabled = controlesModoBloqueados;
  btnManual.disabled = controlesModoBloqueados;

  ligarBomba.disabled = modo !== "manual" || !esp32Online || !sensorOK || controlesModoBloqueados;
  // Prioridade de segurança: desligar fica disponível enquanto um pedido
  // anterior de ligar ainda aguarda resposta. Não permite OFF duplicado.
  desligarBomba.disabled = modo !== "manual" || alteracaoModoEmAndamento || desligamentoEmAndamento;
}

// Cada grupo atualiza apenas a sua seção, preservando a ordem de renderização.
function atualizarDashboard() {
  atualizarReservatorio();
  atualizarBomba();
  atualizarMedicaoENivel();
  atualizarModo();
  atualizarLimitesEControles();
}

// ===========================================================================
// 07. Formatação dos dados
// ===========================================================================

function formatarPercentual(valor) {
  return valor !== null && valor !== undefined ? Math.round(valor) + "%" : "--";
}

function formatarLitros(valor) {
  return valor !== null && valor !== undefined ? Math.round(valor) + " litros" : "--";
}

function formatarNumero(valor) {
  return valor !== null && valor !== undefined ? String(valor) : "--";
}

// ===========================================================================
// 08. Estatísticas e relatórios
// ===========================================================================

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

    const indicadores = {
      statsNivelMedio: formatarPercentual(stats.nivelMedio),
      statsNivelMaximo: formatarPercentual(stats.nivelMaximo),
      statsNivelMinimo: formatarPercentual(stats.nivelMinimo),
      statsConsumo: formatarLitros(stats.consumoEstimado),
      reportNivelMedio: formatarPercentual(stats.nivelMedio),
      reportNivelMaximo: formatarPercentual(stats.nivelMaximo),
      reportNivelMinimo: formatarPercentual(stats.nivelMinimo),
      reportAcionamentos: formatarNumero(stats.acionamentos),
    };

    for (const [id, valor] of Object.entries(indicadores)) set(id, valor);
  } catch (erro) {
    console.error("Erro ao carregar estatísticas:", erro);
  }
}

// Aplicar a resposta sem transformar o comando desejado em estado confirmado.
function aplicarEstadoDaBomba(dados) {
  bombaConfirmada = typeof dados.bombaConfirmada === "boolean" ? dados.bombaConfirmada : null;
  bombaDesejada = dados.bombaDesejada === true;
  comandoPendente = dados.comandoPendente === true;

  if (typeof dados.esp32Online === "boolean") esp32Online = dados.esp32Online;
  if (typeof dados.sensorOK === "boolean") sensorOK = dados.sensorOK;
}

// ===========================================================================
// 09. Requisições e confirmação do controle
// ===========================================================================
// ID temporário deste painel e sequência crescente para /api/bomba e /api/modo.
// Não é autenticação: serve apenas para rejeitar solicitações fora de ordem.
// Ao recarregar a página, um novo ID impede conflito com números antigos.
const clienteControleId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let sequenciaControle = 0;

function proximaOrdemControle() {
  return { clienteControleId, sequenciaControle: ++sequenciaControle };
}

// Um timeout libera os controles quando a rede não responde. Abort não
// garante que o servidor tenha cancelado a operação: nunca anunciar que
// um comando falhou com certeza quando sua confirmação HTTP foi perdida.
async function requisitarJSON(url, opcoes, timeoutMs = 15000) {
  const controlador = typeof AbortController === "function" ? new AbortController() : null;
  const opcoesFinais = controlador ? { ...(opcoes || {}), signal: controlador.signal } : opcoes;

  const temporizador =
    controlador && typeof setTimeout === "function"
      ? setTimeout(() => controlador.abort(), timeoutMs)
      : null;
  try {
    const resposta = await fetch(url, opcoesFinais);
    const dados = await resposta.json();

    return { resposta, dados };
  } finally {
    if (temporizador !== null) clearTimeout(temporizador);
  }
}

function opcoesPOST(corpo) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  };
}

async function solicitarBomba(ligar) {
  if (modo !== "manual" || alteracaoModoEmAndamento) {
    alert("Controle disponível somente no modo manual, sem alteração de modo em andamento.");
    return;
  }
  if (ligar && nivel >= maximo) {
    alert("A bomba não pode ser ligada. Limite máximo atingido.");
    return;
  }
  if (ligar && (!esp32Online || !sensorOK)) {
    alert("Não é possível ligar: ESP32 offline ou sensor indisponível.");
    return;
  }

  if (ligar && (ligamentoEmAndamento || desligamentoEmAndamento)) return;
  if (!ligar && desligamentoEmAndamento) return;

  // Não bloqueia DESLIGAR enquanto LIGAR está pendente. Se as duas
  // requisições chegarem invertidas, o backend ignora o LIGAR antigo.
  if (ligar) ligamentoEmAndamento = true;
  else desligamentoEmAndamento = true;

  const ordem = proximaOrdemControle();

  revisaoEstadoLocal++;
  atualizarDashboard();
  try {
    const { resposta, dados } = await requisitarJSON("/api/bomba", opcoesPOST({ ligar, ...ordem }));
    // Respostas antigas nunca reescrevem a última intenção do usuário.
    if (ordem.sequenciaControle !== sequenciaControle) return;

    if (!resposta.ok) {
      alert(dados.erro || `Não foi possível solicitar ${ligar ? "ligar" : "desligar"} a bomba.`);
      return;
    }

    revisaoEstadoLocal++;
    aplicarEstadoDaBomba(dados);
    atualizarDashboard();
  } catch (erro) {
    console.error("Falha ao solicitar comando da bomba:", erro);
    if (ordem.sequenciaControle === sequenciaControle) {
      alert(
        `Não foi possível confirmar o pedido de ${ligar ? "ligar" : "desligar"}. A operação pode ter chegado ao servidor. Consulte o estado da bomba antes de tentar novamente.`,
      );

      void buscarDados();
    }
  } finally {
    if (ligar) ligamentoEmAndamento = false;
    else desligamentoEmAndamento = false;

    atualizarDashboard();
  }
}

ligarBomba.addEventListener("click", () => solicitarBomba(true));
desligarBomba.addEventListener("click", () => solicitarBomba(false));

/* SELEÇÃO DE MODO: apenas um POST por vez. A resposta confirmada pelo
 * servidor, nunca um valor fixo do botão, determina o estado exibido. */
async function solicitarModo(novoModo) {
  if (alteracaoModoEmAndamento || ligamentoEmAndamento || desligamentoEmAndamento) {
    return;
  }
  alteracaoModoEmAndamento = true;
  const ordem = proximaOrdemControle();
  revisaoEstadoLocal++;
  atualizarDashboard();
  try {
    const { resposta, dados } = await requisitarJSON(
      "/api/modo",
      opcoesPOST({ modo: novoModo, ...ordem }),
    );

    if (!resposta.ok) {
      alert(dados.erro || "Não foi possível alterar o modo.");
      return;
    }

    revisaoEstadoLocal++;
    modo = dados.modo;
    aplicarEstadoDaBomba(dados);
    atualizarDashboard();
  } catch (erro) {
    console.error("Falha ao alterar o modo:", erro);
    alert(
      "Não foi possível confirmar a mudança de modo. O servidor pode ter recebido a solicitação. Verifique o modo atual antes de tentar novamente.",
    );

    void buscarDados();
  } finally {
    alteracaoModoEmAndamento = false;
    atualizarDashboard();
  }
}

btnAutomatico.addEventListener("click", () => solicitarModo("automatico"));
btnManual.addEventListener("click", () => solicitarModo("manual"));

/* EDIÇÃO DOS LIMITES: rascunho separado dos valores confirmados.
 * Blur, click fora e polling NÃO descartam a edição. Cancelar restaura.
 * Isso funciona com mouse, teclado e tela sensível ao toque. */
let limitesEmEdicao = false;
let limitesRascunho = { minimo, maximo };

function atualizarRascunhoLimites() {
  limitesEmEdicao = true;

  limitesRascunho = { minimo: Number(inputMin.value), maximo: Number(inputMax.value) };

  minValue.textContent = limitesRascunho.minimo;
  maxValue.textContent = limitesRascunho.maximo;

  if (bandaValue)
    bandaValue.textContent = Math.max(0, limitesRascunho.maximo - limitesRascunho.minimo);

  cancelarLimites.disabled = false;
}

function encerrarEdicaoLimites() {
  limitesEmEdicao = false;
  limitesRascunho = { minimo, maximo };
  atualizarDashboard();
}

inputMin.addEventListener("input", atualizarRascunhoLimites);
inputMax.addEventListener("input", atualizarRascunhoLimites);
cancelarLimites.addEventListener("click", encerrarEdicaoLimites);

// ===========================================================================
// 10. Envio dos limites ao backend
// ===========================================================================

salvarLimites.addEventListener("click", async () => {
  if (salvamentoLimitesEmAndamento) return;

  const novoMinimo = limitesEmEdicao ? limitesRascunho.minimo : minimo;
  const novoMaximo = limitesEmEdicao ? limitesRascunho.maximo : maximo;

  if (
    !Number.isFinite(novoMinimo) ||
    !Number.isFinite(novoMaximo) ||
    novoMinimo < 1 ||
    novoMaximo > 97 ||
    novoMinimo >= novoMaximo
  ) {
    alert("Escolha mínimo entre 1% e 96% e máximo maior que o mínimo, até 97%.");
    return;
  }

  // Impede POSTs sobrepostos e preserva os sliders enquanto salva.
  salvamentoLimitesEmAndamento = true;
  revisaoEstadoLocal++;
  atualizarDashboard();
  try {
    const { resposta, dados } = await requisitarJSON(
      "/api/limites",
      opcoesPOST({ minimo: novoMinimo, maximo: novoMaximo }),
    );

    if (!resposta.ok) {
      alert(dados.erro || "Erro ao salvar limites.");
      return;
    }

    revisaoEstadoLocal++;
    minimo = dados.minimo;
    maximo = dados.maximo;
    encerrarEdicaoLimites();
    alert("Limites atualizados.");
  } catch (erro) {
    console.error("Falha ao salvar limites:", erro);
    alert(
      "Não foi possível confirmar os novos limites. O servidor pode ter recebido a alteração. Consulte os valores atuais antes de tentar novamente.",
    );
    void buscarDados();
  } finally {
    salvamentoLimitesEmAndamento = false;
    atualizarDashboard();
  }
});

// ===========================================================================
// 11. Gráfico de nível
// ===========================================================================

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

// ===========================================================================
// 12. Atualização do estado
// ===========================================================================
// Uma única consulta em andamento: em redes lentas, novas chamadas reutilizam
// a mesma Promise. Um timeout permite tentar novamente se a rede travar.
// POSTs invalidam SOMENTE as consultas iniciadas antes da operação.
let consultaStatusEmAndamento = null;

function buscarDados() {
  if (consultaStatusEmAndamento) return consultaStatusEmAndamento;
  const revisaoNoInicio = revisaoEstadoLocal;

  const consulta = (async () => {
    try {
      const { resposta, dados } = await requisitarJSON("/api/status");

      if (revisaoNoInicio !== revisaoEstadoLocal) return;
      if (!resposta.ok) throw new Error("Erro ao buscar dados.");

      nivel = dados.nivel;
      ultimaMedicaoDataHora = dados.ultimaLeituraDataHora || null;
      litrosAtual = Number(dados.litros) || 0;
      aplicarEstadoDaBomba(dados);
      minimo = dados.minimo;
      maximo = dados.maximo;
      modo = dados.modo;

      if (sensorBanner) {
        const falhaSensor = dados.sensorOK === false;
        const esp32Desconectado = dados.esp32Online === false;

        sensorBanner.classList.toggle("hidden", !falhaSensor && !esp32Desconectado);
        sensorBanner.textContent = esp32Desconectado
          ? "ESP32 sem comunicação. Estado da bomba não confirmado."
          : "Sensor de nível com falha. Exibindo a última leitura válida.";
      }

      atualizarIndicadorConexao(
        !esp32Online ? "esp32_offline" : !sensorOK ? "sensor_falha" : "online",
      );
      atualizarDashboard();
    } catch (erro) {
      if (revisaoNoInicio !== revisaoEstadoLocal) return;

      console.error("Erro de comunicação:", erro);
      esp32Online = false;
      bombaConfirmada = null;
      atualizarIndicadorConexao("servidor_offline");
      atualizarDashboard();
    }
  })();

  consultaStatusEmAndamento = consulta;

  void consulta.finally(() => {
    if (consultaStatusEmAndamento === consulta) consultaStatusEmAndamento = null;
  });

  return consulta;
}

// ===========================================================================
// 13. Atualização periódica de dados
// ===========================================================================

setInterval(() => {
  buscarDados();
  atualizarGrafico();
  buscarUltimosEventos();
  buscarEstatisticas();
  buscarAlertas();
}, 5000);

// Primeira carga; as funções declaradas abaixo estão disponíveis por hoisting.

buscarDados();
atualizarGrafico();
buscarUltimosEventos();
buscarEstatisticas();

// ===========================================================================
// 14. Histórico de medições
// ===========================================================================

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
        const { data, hora } = formatarDataHora(registro.dataHora);

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

buscarHistorico();

/* Formatação compartilhada por alertas, eventos e histórico. */
function formatarDataHora(valor) {
  const dataHora = new Date(valor);
  return {
    data: dataHora.toLocaleDateString("pt-BR"),
    hora: dataHora.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}

// ===========================================================================
// 15. Alertas
// ===========================================================================

const TITULOS_ALERTAS = {
  nivel_critico: "Nível crítico",
  corte_seguranca: "Corte de segurança",
  esp32_offline: "ESP32 offline",
  sensor_falha: "Falha no sensor",
};

/* Gera o HTML de um alerta, com data apenas na visualização detalhada. */
function criarAlertaHTML(alerta, mostrarData = false) {
  const { data, hora } = formatarDataHora(alerta.dataHora);
  const titulo = Object.hasOwn(TITULOS_ALERTAS, alerta.tipo)
    ? TITULOS_ALERTAS[alerta.tipo]
    : alerta.tipo;

  const nivelTexto = alerta.nivel !== undefined ? ` Nível registrado: ${alerta.nivel}%.` : "";

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

// O slice evita inverter o próprio histórico armazenado.
function renderizarAlertas(alertas, mostrarData) {
  return alertas
    .slice()
    .reverse()
    .map((alerta) => criarAlertaHTML(alerta, mostrarData))
    .join("");
}

async function buscarAlertas() {
  try {
    const [respostaAtivos, respostaHistorico] = await Promise.all([
      fetch("/api/alertas/ativos"),
      fetch("/api/alertas"),
    ]);

    if (!respostaAtivos.ok || !respostaHistorico.ok) throw new Error("Erro ao buscar alertas.");

    const alertasAtivos = await respostaAtivos.json();
    const historicoAlertas = await respostaHistorico.json();

    if (listaAlertas) listaAlertas.innerHTML = "";
    if (alertasDashboard) alertasDashboard.innerHTML = "";

    if (listaAlertas) {
      listaAlertas.innerHTML =
        "<h4>Alertas ativos</h4>" +
        (alertasAtivos.length
          ? renderizarAlertas(alertasAtivos, true)
          : "<p>Nenhum alerta ativo.</p>") +
        '<h4 class="alert-history-title">Histórico de alertas</h4>' +
        (historicoAlertas.length
          ? renderizarAlertas(historicoAlertas, true)
          : "<p>Nenhum alerta registrado.</p>");
    }

    if (alertasDashboard) {
      alertasDashboard.innerHTML = alertasAtivos.length
        ? alertasAtivos
            .slice()
            .reverse()
            .slice(0, 2)
            .map((alerta) => criarAlertaHTML(alerta, false))
            .join("")
        : "<p>Nenhum alerta ativo.</p>";
    }
  } catch (erro) {
    console.error("Erro ao carregar alertas:", erro);

    if (listaAlertas) listaAlertas.innerHTML = "<p>Erro ao carregar os alertas.</p>";
    if (alertasDashboard) alertasDashboard.innerHTML = "<p>Erro ao carregar os alertas.</p>";
  }
}

buscarAlertas();

// ===========================================================================
// 16. Eventos da bomba
// ===========================================================================

function criarEventoBombaHTML(evento) {
  const { data, hora } = formatarDataHora(evento.dataHora);
  const estado = evento.estado === "ligada" ? "Bomba ligada" : "Bomba desligada";
  const icone = evento.estado === "ligada" ? "▶" : "■";

  const modoEvento =
    evento.modo === "automatico"
      ? "Automático"
      : evento.modo === "manual"
        ? "Manual"
        : "Não informado";

  return `
        <div class="evento-bomba">
            <p>${icone} <strong>${estado}</strong></p>
            <small>${data} • ${hora} • Modo: ${modoEvento}</small>
        </div>
    `;
}

async function buscarUltimosEventos() {
  if (!eventosDashboard) return;

  try {
    const resposta = await fetch("/api/historico-bomba");

    if (!resposta.ok) throw new Error("Erro ao buscar histórico da bomba.");

    const historicoBomba = await resposta.json();

    eventosDashboard.innerHTML = "";

    if (historicoBomba.length === 0) {
      eventosDashboard.innerHTML = "<p>Nenhum acionamento da bomba registrado.</p>";
      return;
    }

    /* Exibe as cinco transições mais recentes em ordem decrescente de data. */
    const eventosOrdenados = historicoBomba
      .slice()
      .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));

    eventosDashboard.innerHTML = eventosOrdenados.slice(0, 5).map(criarEventoBombaHTML).join("");
  } catch (erro) {
    console.error("Erro ao carregar eventos da bomba:", erro);

    eventosDashboard.innerHTML = "<p>Erro ao carregar os eventos da bomba.</p>";
  }
}
