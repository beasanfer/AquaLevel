/* Monitoramento do nível de água - AquaLevel */

/* 1. VARIÁVEIS */

let modo="automatico";
let nivel=72;
let bombaLigada=true;
let minimo=30;
let maximo=90;


/* 2. ELEMENTOS HTML */

const percentual=document.getElementById("percentual");
const litros=document.getElementById("litros");
const agua=document.getElementById("agua");
const bombaStatus=document.getElementById("bombaStatus");
const ultimaMedicao=document.getElementById("ultimaMedicao");
const horaAtualizacao=document.getElementById("horaAtualizacao");
const btnAutomatico=document.getElementById("btnAutomatico");
const btnManual=document.getElementById("btnManual");
const ligarBomba=document.getElementById("ligarBomba");
const desligarBomba=document.getElementById("desligarBomba");
const inputMin=document.getElementById("minimo");
const inputMax=document.getElementById("maximo");
const minValue=document.getElementById("minValue");
const maxValue=document.getElementById("maxValue");
const salvarLimites=document.getElementById("salvarLimites");
const tabelaHistorico=document.getElementById("tabelaHistorico");
const listaAlertas=document.getElementById("listaAlertas");
const alertasDashboard=document.getElementById("alertas");
const eventosDashboard=document.getElementById("eventos");
/* ISSUE #23 */

const minimoConfiguracao=document.getElementById("minimoConfiguracao");
const maximoConfiguracao=document.getElementById("maximoConfiguracao");
const modoConfiguracao=document.getElementById("modoConfiguracao");

 /* ACESSIBILIDADE */

const diminuirFonte=document.getElementById("diminuirFonte");
const aumentarFonte=document.getElementById("aumentarFonte");
const alternarContraste=document.getElementById("alternarContraste");

let tamanhoFonte=Number(
    localStorage.getItem("aqualevelFonte")
)||100;

let contrasteAtivo=
    localStorage.getItem("aqualevelContraste")==="true";

function aplicarAcessibilidade(){

    document.documentElement.style.fontSize=
        tamanhoFonte+"%";

    document.body.classList.toggle(
        "alto-contraste",
        contrasteAtivo
    );

    alternarContraste.setAttribute(
        "aria-pressed",
        String(contrasteAtivo)
    );

    alternarContraste.classList.toggle(
        "ativo",
        contrasteAtivo
    );

    alternarContraste.title=
        contrasteAtivo
            ?"Desativar alto contraste"
            :"Ativar alto contraste";

}

diminuirFonte.addEventListener("click",()=>{

    tamanhoFonte=Math.max(
        85,
        tamanhoFonte-10
    );

    localStorage.setItem(
        "aqualevelFonte",
        tamanhoFonte
    );

    aplicarAcessibilidade();

});

aumentarFonte.addEventListener("click",()=>{

    tamanhoFonte=Math.min(
        130,
        tamanhoFonte+10
    );

    localStorage.setItem(
        "aqualevelFonte",
        tamanhoFonte
    );

    aplicarAcessibilidade();

});

alternarContraste.addEventListener("click",()=>{

    contrasteAtivo=!contrasteAtivo;

    localStorage.setItem(
        "aqualevelContraste",
        String(contrasteAtivo)
    );

    aplicarAcessibilidade();

});

aplicarAcessibilidade();

/* 3. NAVEGAÇÃO */

const navLinks=document.querySelectorAll(".nav-link");
const pages=document.querySelectorAll(".page");

navLinks.forEach(link=>{

    link.addEventListener("click",()=>{

        const pageId=link.dataset.page;

        pages.forEach(page=>{
            page.classList.remove("active-page");
        });

        navLinks.forEach(item=>{
            item.classList.remove("active");
        });

        document.getElementById(pageId).classList.add("active-page");
        link.classList.add("active");

        if(pageId==="historico"){
            buscarHistorico();
        }

        if(pageId==="alertas-page"){
            buscarAlertas();
        }

        if(pageId==="configuracoes"){
            buscarDados();
        }

        if(pageId==="dashboard"){
            atualizarGrafico();
            buscarUltimosEventos();
        }

        window.scrollTo(0,0);

    });

});


/* 4. ATUALIZAR INTERFACE */

function atualizarDashboard(){

    percentual.textContent=nivel+"%";
    litros.textContent=nivel*10+" litros";
    agua.style.height=nivel+"%";

    bombaStatus.textContent=bombaLigada?"Ligada":"Desligada";
    bombaStatus.style.color=bombaLigada?"#27a355":"#ef4040";

    const agora=new Date().toLocaleTimeString();

    ultimaMedicao.textContent=agora;
    horaAtualizacao.textContent=agora;

    const nivelStatus=document.getElementById("nivelStatus");

    if(nivel<minimo){

        nivelStatus.textContent="Nível crítico";
        nivelStatus.parentElement.style.color="#c92d2d";

    }else if(nivel>=maximo){

        nivelStatus.textContent="Nível máximo";
        nivelStatus.parentElement.style.color="#0877e8";

    }else{

        nivelStatus.textContent="Nível normal";
        nivelStatus.parentElement.style.color="#29a45d";

    }

    if(modo==="automatico"){

        btnAutomatico.classList.add("active-mode");
        btnManual.classList.remove("active-mode");

    }else{

        btnManual.classList.add("active-mode");
        btnAutomatico.classList.remove("active-mode");

    }

    const acionamentoBomba=document.getElementById("acionamentoBomba");

    if(acionamentoBomba){

        acionamentoBomba.textContent=
            modo==="automatico"?"Automático":"Manual";

    }

    /* ISSUE #23 - CONFIGURAÇÕES */

    if(minimoConfiguracao){
        minimoConfiguracao.textContent=minimo+"%";
    }

    if(maximoConfiguracao){
        maximoConfiguracao.textContent=maximo+"%";
    }

    if(modoConfiguracao){

        modoConfiguracao.textContent=
            modo==="automatico"?"Automático":"Manual";

    }

    ligarBomba.disabled=modo!=="manual";
    desligarBomba.disabled=modo!=="manual";

}


/* 5. LIGAR BOMBA */

ligarBomba.addEventListener("click",async()=>{

    if(modo!=="manual"){

        alert("Controle disponível somente no modo manual.");
        return;

    }

    if(nivel>=maximo){

        alert(
            "A bomba não pode ser ligada. Limite máximo atingido."
        );

        return;

    }

    try{

        const resposta=await fetch("/api/bomba",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({
                ligar:true
            })
        });

        const dados=await resposta.json();

        if(!resposta.ok){

            alert(
                dados.erro||"Erro ao ligar a bomba."
            );

            return;

        }

        bombaLigada=true;
        atualizarDashboard();

    }catch(erro){

        console.error("Erro:",erro);

    }

});


/* 6. DESLIGAR BOMBA */

desligarBomba.addEventListener("click",async()=>{

    if(modo!=="manual"){

        alert("Controle disponível somente no modo manual.");
        return;

    }

    try{

        const resposta=await fetch("/api/bomba",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({
                ligar:false
            })
        });

        const dados=await resposta.json();

        if(!resposta.ok){

            alert(
                dados.erro||"Erro ao desligar a bomba."
            );

            return;

        }

        bombaLigada=false;
        atualizarDashboard();

    }catch(erro){

        console.error("Erro:",erro);

    }

});


/* 7. MODO AUTOMÁTICO */

btnAutomatico.addEventListener("click",async()=>{

    try{

        const resposta=await fetch("/api/modo",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({
                modo:"automatico"
            })
        });

        const dados=await resposta.json();

        if(!resposta.ok){

            alert(
                dados.erro||"Erro ao alterar modo."
            );

            return;

        }

        modo="automatico";
        atualizarDashboard();

    }catch(erro){

        console.error("Erro:",erro);

    }

});


/* 8. MODO MANUAL */

btnManual.addEventListener("click",async()=>{

    try{

        const resposta=await fetch("/api/modo",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({
                modo:"manual"
            })
        });

        const dados=await resposta.json();

        if(!resposta.ok){

            alert(
                dados.erro||"Erro ao alterar modo."
            );

            return;

        }

        modo="manual";
        atualizarDashboard();

    }catch(erro){

        console.error("Erro:",erro);

    }

});


/* 9. MOSTRAR LIMITES */

inputMin.addEventListener("input",()=>{

    minValue.textContent=inputMin.value;

});

inputMax.addEventListener("input",()=>{

    maxValue.textContent=inputMax.value;

});


/* 10. SALVAR LIMITES */

salvarLimites.addEventListener("click",async()=>{

    const novoMinimo=Number(inputMin.value);
    const novoMaximo=Number(inputMax.value);

    if(novoMinimo>=novoMaximo){

        alert(
            "O limite mínimo deve ser menor que o máximo."
        );

        return;

    }

    try{

        const resposta=await fetch("/api/limites",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({
                minimo:novoMinimo,
                maximo:novoMaximo
            })
        });

        const dados=await resposta.json();

        if(!resposta.ok){

            alert(
                dados.erro||"Erro ao salvar limites."
            );

            return;

        }

        minimo=novoMinimo;
        maximo=novoMaximo;

        atualizarDashboard();

        alert("Limites atualizados.");

    }catch(erro){

        console.error("Erro:",erro);

    }

});


/* 11. GRÁFICO - ISSUE #25 */

const ctx=document.getElementById("graficoNivel");

const grafico=new Chart(ctx,{

    type:"line",

    data:{

        labels:[],

        datasets:[{

            label:"Nível da água (%)",
            data:[],
            borderColor:"#0877e8",
            tension:0.3,
            fill:false

        }]

    },

    options:{

        responsive:true,

        scales:{

            y:{
                min:0,
                max:100
            }

        }

    }

});


/* ATUALIZAR GRÁFICO COM O HISTÓRICO */

async function atualizarGrafico(){

    try{

        const resposta=await fetch("/api/historico");

        if(!resposta.ok){

            throw new Error(
                "Erro ao buscar dados do gráfico."
            );

        }

        const historico=await resposta.json();

        if(historico.length===0){

            grafico.data.labels=[];
            grafico.data.datasets[0].data=[];

            grafico.update();

            return;

        }

        /* Exibe as 20 medições mais recentes */

        const registros=historico.slice(-20);

        const horarios=registros.map(registro=>{

            const dataHora=new Date(registro.dataHora);

            return dataHora.toLocaleTimeString(
                "pt-BR",
                {
                    hour:"2-digit",
                    minute:"2-digit",
                    second:"2-digit"
                }
            );

        });

        const niveis=registros.map(registro=>
            Number(registro.nivel)
        );

        grafico.data.labels=horarios;
        grafico.data.datasets[0].data=niveis;

        grafico.update();

    }catch(erro){

        console.error(
            "Erro ao atualizar gráfico:",
            erro
        );

    }

}


/* 12. BUSCAR DADOS DO SERVIDOR */

async function buscarDados(){

    try{

        const resposta=await fetch("/api/status");

        if(!resposta.ok){

            throw new Error(
                "Erro ao buscar dados."
            );

        }

        const dados=await resposta.json();

        nivel=dados.nivel;
        bombaLigada=dados.bombaLigada;
        minimo=dados.minimo;
        maximo=dados.maximo;
        modo=dados.modo;

        inputMin.value=minimo;
        inputMax.value=maximo;

        minValue.textContent=minimo;
        maxValue.textContent=maximo;

        atualizarDashboard();

    }catch(erro){

        console.error(
            "Erro de comunicação:",
            erro
        );

    }

}


/* 13. ATUALIZAÇÃO AUTOMÁTICA */

setInterval(()=>{

    buscarDados();

    atualizarGrafico();

    buscarUltimosEventos();

},5000);


/* 14. PRIMEIRA BUSCA */

buscarDados();
atualizarGrafico();
buscarUltimosEventos();

/* 15. HISTÓRICO DE MEDIÇÕES - ISSUE #19 */

async function buscarHistorico(){

    if(!tabelaHistorico){
        return;
    }

    try{

        const resposta=await fetch("/api/historico");

        if(!resposta.ok){

            throw new Error(
                "Erro ao buscar histórico."
            );

        }

        const historico=await resposta.json();

        tabelaHistorico.innerHTML="";

        if(historico.length===0){

            tabelaHistorico.innerHTML=`
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
            .forEach(registro=>{

                const dataHora=
                    new Date(registro.dataHora);

                const data=
                    dataHora.toLocaleDateString(
                        "pt-BR"
                    );

                const hora=
                    dataHora.toLocaleTimeString(
                        "pt-BR",
                        {
                            hour:"2-digit",
                            minute:"2-digit",
                            second:"2-digit"
                        }
                    );

                const linha=
                    document.createElement("tr");

                linha.innerHTML=`
                    <td>${data}</td>
                    <td>${hora}</td>
                    <td>${registro.nivel}%</td>
                    <td>${registro.litros} L</td>
                    <td>-</td>
                    <td>-</td>
                `;

                tabelaHistorico.appendChild(
                    linha
                );

            });

    }catch(erro){

        console.error(
            "Erro ao carregar histórico:",
            erro
        );

        tabelaHistorico.innerHTML=`
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

function criarAlertaHTML(alerta,mostrarData=false){

    const dataHora=new Date(alerta.dataHora);

    const data=dataHora.toLocaleDateString("pt-BR");

    const hora=dataHora.toLocaleTimeString(
        "pt-BR",
        {
            hour:"2-digit",
            minute:"2-digit",
            second:"2-digit"
        }
    );

    const titulo=
        alerta.tipo==="nivel_critico"
            ?"Nível crítico"
            :alerta.tipo;

    const nivelTexto=
        alerta.nivel!==undefined
            ?` Nível registrado: ${alerta.nivel}%.`
            :"";

    return `
        <div class="alert danger">
            ⚠
            <div>
                <strong>${titulo}</strong>
                <p>${alerta.mensagem}${nivelTexto}</p>
                ${
                    mostrarData
                        ?`<small>${data} • ${hora}</small>`
                        :""
                }
            </div>
        </div>
    `;

}


async function buscarAlertas(){

    try{

        const resposta=await fetch("/api/alertas");

        if(!resposta.ok){

            throw new Error(
                "Erro ao buscar alertas."
            );

        }

        const alertas=await resposta.json();

        if(listaAlertas){
            listaAlertas.innerHTML="";
        }

        if(alertasDashboard){
            alertasDashboard.innerHTML="";
        }

        if(alertas.length===0){

            if(listaAlertas){

                listaAlertas.innerHTML=
                    "<p>Nenhum alerta registrado.</p>";

            }

            if(alertasDashboard){

                alertasDashboard.innerHTML=
                    "<p>Nenhum alerta ativo.</p>";

            }

            return;

        }

        const alertasOrdenados=
            alertas.slice().reverse();

        if(listaAlertas){

            alertasOrdenados.forEach(alerta=>{

                listaAlertas.innerHTML+=
                    criarAlertaHTML(alerta,true);

            });

        }

        if(alertasDashboard){

            alertasOrdenados
                .slice(0,2)
                .forEach(alerta=>{

                    alertasDashboard.innerHTML+=
                        criarAlertaHTML(alerta,false);

                });

        }

    }catch(erro){

        console.error(
            "Erro ao carregar alertas:",
            erro
        );

        if(listaAlertas){

            listaAlertas.innerHTML=
                "<p>Erro ao carregar os alertas.</p>";

        }

        if(alertasDashboard){

            alertasDashboard.innerHTML=
                "<p>Erro ao carregar os alertas.</p>";

        }

    }

}


/* 18. PRIMEIRA BUSCA DOS ALERTAS */

buscarAlertas();

/* 19. ÚLTIMOS EVENTOS DA BOMBA - ISSUE #27 */


function criarEventoBombaHTML(evento){

    const dataHora=new Date(evento.dataHora);

    const data=dataHora.toLocaleDateString("pt-BR");

    const hora=dataHora.toLocaleTimeString(
        "pt-BR",
        {
            hour:"2-digit",
            minute:"2-digit",
            second:"2-digit"
        }
    );

    const estado=
        evento.estado==="ligada"
            ?"Bomba ligada"
            :"Bomba desligada";

    const icone=
        evento.estado==="ligada"
            ?"▶"
            :"■";

    const modoEvento=
        evento.modo==="automatico"
            ?"Automático"
            :"Manual";

    return `
        <div class="evento-bomba">
            <p>${icone} <strong>${estado}</strong></p>
            <small>${data} • ${hora} • Modo: ${modoEvento}</small>
        </div>
    `;

}


async function buscarUltimosEventos(){

    if(!eventosDashboard){

        return;

    }

    try{

        const resposta=await fetch("/api/historico-bomba");

        if(!resposta.ok){

            throw new Error(
                "Erro ao buscar histórico da bomba."
            );

        }

        const historicoBomba=await resposta.json();

        eventosDashboard.innerHTML="";

        if(historicoBomba.length===0){

            eventosDashboard.innerHTML=
                "<p>Nenhum acionamento da bomba registrado.</p>";

            return;

        }

        const eventosOrdenados=
            historicoBomba
                .slice()
                .sort(
                    (a,b)=>
                        new Date(b.dataHora)-
                        new Date(a.dataHora)
                );

        eventosOrdenados
            .slice(0,5)
            .forEach(evento=>{

                eventosDashboard.innerHTML+=
                    criarEventoBombaHTML(evento);

            });

    }catch(erro){

        console.error(
            "Erro ao carregar eventos da bomba:",
            erro
        );

        eventosDashboard.innerHTML=
            "<p>Erro ao carregar os eventos da bomba.</p>";

    }

}