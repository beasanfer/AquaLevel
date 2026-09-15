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

/* 3. NAVEGAÇÃO */
const navLinks=document.querySelectorAll(".nav-link");
const pages=document.querySelectorAll(".page");

navLinks.forEach(link=>{
    link.addEventListener("click",()=>{
        const pageId=link.dataset.page;
        pages.forEach(page=>page.classList.remove("active-page"));
        navLinks.forEach(item=>item.classList.remove("active"));
        document.getElementById(pageId).classList.add("active-page");
        link.classList.add("active");
        window.scrollTo(0,0);
    });
});

/* 4. ATUALIZAR DASHBOARD */
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
        acionamentoBomba.textContent=modo==="automatico"?"Automático":"Manual";
    }

    const modoConfiguracao=document.getElementById("modoConfiguracao");
    if(modoConfiguracao){
        modoConfiguracao.textContent=modo==="automatico"?"Automático":"Manual";
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
        alert("A bomba não pode ser ligada. Limite máximo atingido.");
        return;
    }
    try{
        const resposta=await fetch("/api/bomba",{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({ligar:true})
        });
        const dados=await resposta.json();
        if(!resposta.ok){
            alert(dados.erro||"Erro ao ligar a bomba.");
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
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({ligar:false})
        });
        const dados=await resposta.json();
        if(!resposta.ok){
            alert(dados.erro||"Erro ao desligar a bomba.");
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
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({modo:"automatico"})
        });
        const dados=await resposta.json();
        if(!resposta.ok){
            alert(dados.erro||"Erro ao alterar modo.");
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
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({modo:"manual"})
        });
        const dados=await resposta.json();
        if(!resposta.ok){
            alert(dados.erro||"Erro ao alterar modo.");
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
        alert("O limite mínimo deve ser menor que o máximo.");
        return;
    }
    try{
        const resposta=await fetch("/api/limites",{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
                minimo:novoMinimo,
                maximo:novoMaximo
            })
        });
        const dados=await resposta.json();
        if(!resposta.ok){
            alert(dados.erro||"Erro ao salvar limites.");
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

/* 11. GRÁFICO */
const ctx=document.getElementById("graficoNivel");
const grafico=new Chart(ctx,{
    type:"line",
    data:{
        labels:["10:00","12:00","14:00","16:00","18:00","20:00"],
        datasets:[{
            label:"Nível da água (%)",
            data:[60,52,63,70,68,72],
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

/* 12. BUSCAR DADOS DO SERVIDOR */
async function buscarDados(){
    try{
        const resposta=await fetch("/api/status");
        if(!resposta.ok){
            throw new Error("Erro ao buscar dados.");
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
        console.error("Erro de comunicação:",erro);
    }
}

/* 13. ATUALIZAÇÃO AUTOMÁTICA */
setInterval(buscarDados,5000);

/* 14. PRIMEIRA BUSCA */
buscarDados();