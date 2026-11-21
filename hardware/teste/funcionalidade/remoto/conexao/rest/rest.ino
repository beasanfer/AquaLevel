#include <Arduino.h>
#include <algorithm>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_system.h> // esp_random(): identificador novo a cada inicializacao

/* PINOS: HC-SR04, relé da bomba e LEDs indicadores. */
#define PINO_TRIG       13
#define PINO_ECHO       35
#define PINO_RELE       19
#define LED_BOMBA       4
const int LEDS_NIVEL[3] = {18, 17, 16};

/* REDE: credenciais Wi-Fi e endereço da API. */
// Substitua os valores abaixo antes de gravar o firmware.
const char* WIFI_SSID  = "WIFI";
const char* WIFI_SENHA = "KEY";
const char* URL_NIVEL  = "http://IP/api/nivel";

/* PARÂMETROS DE MEDIÇÃO E CONTROLE */
// A polaridade do relé depende do módulo utilizado: ativo em LOW ou HIGH.
const bool RELE_ATIVO_EM_LOW = true;

// ALTURA: distância do sensor ao fundo com o tanque vazio.
// GAP: distância entre sensor e superfície da água com o tanque cheio.
// O curso útil corresponde a ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM.
float ALTURA_RESERVATORIO_CM = 23.6f;
float GAP_SENSOR_CM          = 5.0f;

const float CAPACIDADE_LITROS = 1000.0f;

// Limites iniciais (%) atualizados após resposta válida da API.
float nivelMinimo = 30.0f;
float nivelMaximo = 90.0f;

// Os LEDs refletem os limites recebidos do servidor (inicialmente 30/90%).
float NIVEL_LED_VERMELHO = 30.0f;
float NIVEL_LED_VERDE    = 90.0f;

/* CORTE DE SEGURANÇA: aplica-se a ambos os modos, mesmo sem rede.
 * Deve coincidir com LIMITE_SEGURANCA_MANUAL em server.js.
 * Acionamentos manuais também respeitam nivelMaximo. */
const float NIVEL_CORTE_SEGURANCA = 98.0f;

const int NUMERO_AMOSTRAS = 7;
const unsigned long INTERVALO_LEITURA_MS = 1000UL;

/* ESTADO EM EXECUÇÃO */
bool STATUS_BOMBA = false;
String modoAtual = "automatico";
unsigned long TEMPO_ULTIMA_LEITURA = 0;
float ultimoNivelValido = -1.0f;
// Um ID aplicado não pode executar de novo depois de uma queda da rede.
String ultimoComandoAplicadoId = "";
// Depois de falha no modo manual, exige comando NOVO do usuário.
bool bloqueioManual = false;
// Identifica um boot específico; o backend rejeita comandos de outro boot.
String sessaoESP32 = "";
// Após falha do sensor, não retoma o automático sem verificar o modo atual.
// Mesmo que a API responda durante a falha, confirma novamente na recuperação.
bool aguardandoSincronizacaoAposFalha = false;

enum EstadoNivel { BAIXO = 0, MEDIO = 1, CHEIO = 2 };

/* CONEXÃO E RECONEXÃO WI-FI */
void conectarWiFi() {
  Serial.printf("Conectando em %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi OK. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nFalha no WiFi. Seguirei em modo offline.");
  }
}

void garantirWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  // Aguarda pelo menos 5 s entre tentativas de reconexão.
  static unsigned long ultimaTentativa = 0;
  if (millis() - ultimaTentativa < 5000) return;
  ultimaTentativa = millis();
  Serial.println("WiFi caiu. Reconectando...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
}

/* MEDIÇÃO ULTRASSÔNICA */
// Um eco ausente após 30 ms é considerado falha de leitura.
float lerDistanciaCrua() {
  digitalWrite(PINO_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PINO_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PINO_TRIG, LOW);

  unsigned long duracao = pulseIn(PINO_ECHO, HIGH, 30000UL);
  if (duracao == 0) return -1.0;
  return (duracao * 0.0343) / 2.0;
}

// Coleta até NUMERO_AMOSTRAS medições válidas e ordena os valores.
// Retorna o elemento central; com quantidade par, usa a mediana superior.
float lerDistanciaFiltrada() {
  float leituras[NUMERO_AMOSTRAS];
  int validas = 0;

  for (int i = 0; i < NUMERO_AMOSTRAS; i++) {
    float d = lerDistanciaCrua();
    if (d > 0) leituras[validas++] = d;
    if (i < NUMERO_AMOSTRAS - 1) delay(60);
  }
  if (validas == 0) return -1.0;

  std::sort(leituras, leituras + validas);
  return leituras[validas / 2];
}

// Converte a distância em nível: fundo = 0%, superfície no GAP = 100%.
// Limita o resultado a 0–100% e preserva o valor de falha (-1).
float distanciaParaNivel(float distancia) {
  if (distancia < 0) return -1.0;

  float nivel = (ALTURA_RESERVATORIO_CM - distancia)
    / (ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM) * 100.0;

  if (nivel < 0)   nivel = 0;
  if (nivel > 100) nivel = 100;
  return nivel;
}

/* ATUADORES: relé sempre passa pela verificação local de segurança. */
bool atingiuLimite(float nivel) {
  return nivel >= nivelMaximo || nivel >= NIVEL_CORTE_SEGURANCA;
}

void acionarBomba(bool ligar) {
  if (ligar && (ultimoNivelValido < 0.0f || atingiuLimite(ultimoNivelValido))) {
    Serial.println("Acionamento impedido pelos limites ou falta de leitura.");
    ligar = false;
  }
  STATUS_BOMBA = ligar;
  digitalWrite(PINO_RELE, ligar == RELE_ATIVO_EM_LOW ? LOW : HIGH);
  digitalWrite(LED_BOMBA, ligar ? HIGH : LOW);
}

void apagarLeds() {
  for (int i = 0; i < 3; i++) digitalWrite(LEDS_NIVEL[i], LOW);
  digitalWrite(LED_BOMBA, LOW);
}

// Sinaliza baixo (< mínimo), médio (mínimo até antes do máximo) ou cheio.
void atualizarLedsNivel(float nivel) {
  EstadoNivel estado;
  if (nivel < NIVEL_LED_VERMELHO)      estado = BAIXO;
  else if (nivel < NIVEL_LED_VERDE)    estado = MEDIO;
  else                                 estado = CHEIO;

  for (int i = 0; i < 3; i++)
    digitalWrite(LEDS_NIVEL[i], i == estado ? HIGH : LOW);
}

/* Telemetria via POST; a resposta sincroniza modo, limites e comandos.
 * Retorna true somente para HTTP 200 com configuração válida. */
bool enviarDadosParaServidor(float nivel, float litros) {
  if (WiFi.status() != WL_CONNECTED) return false;

  // Mantém o WiFiClient em escopo até a finalização de http.end().
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(client, URL_NIVEL)) {
    Serial.println("HTTPClient: falha ao iniciar requisicao.");
    return false;
  }
  http.addHeader("Content-Type", "application/json");

  // Payload serializado com ArduinoJson 7.x; em 6.x, usar documento estático.
  JsonDocument payloadDoc;
  payloadDoc["nivel"] = nivel;
  payloadDoc["litros"] = litros;
  payloadDoc["bombaLigada"] = STATUS_BOMBA; // estado atual do GPIO
  // Reporta o modo efetivamente executado, não o modo desejado no servidor.
  // Durante uma troca de modo, esta leitura ainda pertence ao modo anterior.
  payloadDoc["modoESP32"] = modoAtual;
  payloadDoc["sessaoESP32"] = sessaoESP32;
  payloadDoc["comandoAplicadoId"] = ultimoComandoAplicadoId;
  payloadDoc["bloqueioManual"] = bloqueioManual;

  String payload;
  serializeJson(payloadDoc, payload);

  int httpCode = http.POST(payload);
  bool ok = false;

  if (httpCode == HTTP_CODE_OK) {
    String resposta = http.getString();

    JsonDocument doc;  // ArduinoJson 7.x; em 6.x use StaticJsonDocument<256>
    DeserializationError err = deserializeJson(doc, resposta);

    // O backend usa sucesso=false para falha de leitura, MAS devolve modo
    // e limites válidos. Essas configurações devem ser aplicadas também
    // enquanto o sensor falha, sem permitir acionamento do relé.
    const bool respostaDeFalha = !err && nivel < 0.0f &&
      doc["sensorOK"].is<bool>() && doc["sensorOK"].as<bool>() == false;
    if (!err && (doc["sucesso"].as<bool>() == true || respostaDeFalha)) {
      String novoModo = doc["modo"] | modoAtual;
      float novoMin = doc["minimo"] | nivelMinimo;
      float novoMax = doc["maximo"] | nivelMaximo;
      if ((novoModo == "manual" || novoModo == "automatico") &&
          novoMin >= 1.0f && novoMin < novoMax &&
          novoMax <= NIVEL_CORTE_SEGURANCA - 1.0f) {
        // Entrar em modo manual não herda uma bomba ligada pelo automático.
        if (modoAtual != "manual" && novoModo == "manual") {
          acionarBomba(false);
        }
        modoAtual = novoModo;
        nivelMinimo = novoMin;
        nivelMaximo = novoMax;
        NIVEL_LED_VERMELHO = nivelMinimo;
        NIVEL_LED_VERDE = nivelMaximo;

        // Se o servidor mudou o máximo durante o POST, corta imediatamente.
        if (STATUS_BOMBA && atingiuLimite(nivel)) {
          acionarBomba(false);
        }

        // 'bombaLigada' na resposta é apenas telemetria confirmada, nunca
        // uma instrução. Só um comandoManual com ID novo pode acionar.
        JsonVariantConst cmd = doc["comandoManual"];
        if (nivel >= 0.0f && modoAtual == "manual" && !cmd.isNull() &&
            cmd["id"].is<const char*>() && cmd["ligar"].is<bool>()) {
          String id = cmd["id"].as<String>();
          if (id.length() > 0 && id != ultimoComandoAplicadoId) {
            bool ligar = cmd["ligar"].as<bool>();
            acionarBomba(ligar); // bloqueio de maximo/98% tambem aqui
            // Confirma processamento uma vez; se o corte recusou ligar,
            // o backend verá bombaLigada=false ao receber este mesmo ID.
            ultimoComandoAplicadoId = id;
            if (STATUS_BOMBA == ligar) bloqueioManual = false;
            Serial.printf("Comando manual %s: bomba %s\n",
                          id.c_str(), STATUS_BOMBA ? "LIGADA" : "DESLIGADA");
          }
        }
        ok = true;
      } else {
        Serial.println("Resposta contem modo ou limites invalidos.");
      }
    } else if (err) {
      Serial.printf("JSON inválido: %s\n", err.c_str());
    }
  } else {
    Serial.printf("POST falhou. Código: %d\n", httpCode);
  }

  http.end();
  return ok;
}

/* INICIALIZAÇÃO DOS PINOS, ATUADORES E REDE */
void setup() {
  // Primeira operacao do firmware: manter o rele desligado.
  // O estado antes do setup ainda depende do circuito do modulo.
  digitalWrite(PINO_RELE, RELE_ATIVO_EM_LOW ? HIGH : LOW);
  pinMode(PINO_RELE, OUTPUT);
  Serial.begin(115200);
  delay(500);
  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);
  for (int i = 0; i < 3; i++) pinMode(LEDS_NIVEL[i], OUTPUT);
  pinMode(LED_BOMBA, OUTPUT);

  digitalWrite(PINO_TRIG, LOW);
  acionarBomba(false);
  apagarLeds();

  // 64 bits aleatorios por boot para invalidar comandos de outra sessao.
  sessaoESP32 = String(esp_random(), HEX) + "-" + String(esp_random(), HEX);
  conectarWiFi();

  Serial.println("Controlador iniciado.");
}

/* Ciclo: medir, aplicar limites locais, sincronizar e indicar estado. */
void loop() {
  garantirWiFi();

  // Uma queda real do WiFi tambem invalida a operacao manual.
  // Essa trava sera enviada na primeira telemetria apos a reconexao.
  if (modoAtual == "manual" && WiFi.status() != WL_CONNECTED) {
    bloqueioManual = true;
    if (STATUS_BOMBA) acionarBomba(false);
  }

  // Garante um intervalo mínimo entre os inícios das leituras.
  if (millis() - TEMPO_ULTIMA_LEITURA < INTERVALO_LEITURA_MS) {
    delay(1);
    return;
  }
  TEMPO_ULTIMA_LEITURA = millis();

  float distancia = lerDistanciaFiltrada();
  float nivel     = distanciaParaNivel(distancia);

  // Sem eco válido: desliga bomba e LEDs e informa a falha se houver rede.
  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");
    ultimoNivelValido = -1.0f;
    if (modoAtual == "manual") bloqueioManual = true;
    acionarBomba(false);
    apagarLeds();
    aguardandoSincronizacaoAposFalha = true;
    enviarDadosParaServidor(-1.0f, 0.0f);
    return;
  }
  ultimoNivelValido = nivel;
  float litros = nivel * CAPACIDADE_LITROS / 100.0f;

  // Não energiza a bomba no primeiro ciclo recuperado até confirmar
  // modo e limites com o servidor. Uma resposta de falha já processada
  // não basta: o modo pode ter mudado depois daquela resposta.
  bool sincronizouNestaLeitura = false;
  if (aguardandoSincronizacaoAposFalha) {
    if (!enviarDadosParaServidor(nivel, litros)) {
      acionarBomba(false);
      if (modoAtual == "manual") bloqueioManual = true;
      atualizarLedsNivel(nivel);
      Serial.println("Sensor recuperado; aguardando sincronizacao antes de ligar.");
      return;
    }
    aguardandoSincronizacaoAposFalha = false;
    sincronizouNestaLeitura = true;
  }

  // 1. Automático: liga abaixo do mínimo e desliga ao atingir o máximo.
  // O estado é atualizado antes do POST para refletir o relé no envio.
  if (modoAtual == "automatico") {
    if (!STATUS_BOMBA && nivel < nivelMinimo) {
      acionarBomba(true);
    } else if (STATUS_BOMBA && nivel >= nivelMaximo) {
      acionarBomba(false);
    }
  }

  // 2. O modo manual também respeita o máximo configurado (até 97%).
  if (STATUS_BOMBA && atingiuLimite(nivel)) {
    Serial.printf("Corte local: nivel %.1f%%, maximo %.1f%%.\n",
                  nivel, nivelMaximo);
    acionarBomba(false);
  }

  // 3. Evita um segundo POST se a recuperação já sincronizou nesta leitura.
  // O estado do relé após o controle local será confirmado no próximo ciclo.
  bool comunicacaoServidorOK = sincronizouNestaLeitura ||
    enviarDadosParaServidor(nivel, litros);

  // Um POST falho exige um novo comando identificado após a recuperação.
  if (!comunicacaoServidorOK && modoAtual == "manual") {
    Serial.println("Falha de comunicacao: travando comandos manuais antigos.");
    bloqueioManual = true;
    if (STATUS_BOMBA) acionarBomba(false);
  }

  // 4. Defesa adicional após a atualização remota dos limites.
  if (STATUS_BOMBA && atingiuLimite(nivel)) {
    acionarBomba(false);
  }

  // 5. Atualiza os indicadores de nível.
  atualizarLedsNivel(nivel);

  // 6. Registra medição e estado atual no monitor serial.
  Serial.printf("Dist: %.1f cm | Nivel: %.1f%% | Bomba: %s | Modo: %s\n",
                distancia, nivel, STATUS_BOMBA ? "LIGADA" : "DESLIGADA",
                modoAtual.c_str());
}
