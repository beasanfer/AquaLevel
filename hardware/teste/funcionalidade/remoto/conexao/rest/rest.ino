#include <Arduino.h>
#include <algorithm>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

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
 * O limite é verificado antes e depois do POST para impedir que um
 * comando manual recebido reative a bomba acima do nível permitido. */
const float NIVEL_CORTE_SEGURANCA = 98.0f;

const int NUMERO_AMOSTRAS = 7;
const unsigned long INTERVALO_LEITURA_MS = 1000UL;

/* ESTADO EM EXECUÇÃO */
bool STATUS_BOMBA = false;
String modoAtual = "automatico";
unsigned long TEMPO_ULTIMA_LEITURA = 0;

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
// Tempo máximo de espera por um eco: 30 ms.
unsigned long timeoutPulseIn() { return 30000UL; }

// Dispara o TRIG e converte o tempo do ECHO em distância; -1 indica timeout.
float lerDistanciaCrua() {
  digitalWrite(PINO_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PINO_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PINO_TRIG, LOW);

  unsigned long duracao = pulseIn(PINO_ECHO, HIGH, timeoutPulseIn());
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

/* ATUADORES: RELÉ E LEDs */
// Atualiza o estado lógico, o relé e o LED de funcionamento da bomba.
void acionarBomba(bool ligar) {
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

/* COMUNICAÇÃO BIDIRECIONAL COM A API
 * Um POST envia nível, volume e estado da bomba. A resposta devolve
 * modo, limites e comando manual. Retorna true apenas com HTTP 200
 * e JSON válido. ArduinoJson evita montar JSON por concatenações. */
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
  payloadDoc["nivel"]      = nivel;
  payloadDoc["litros"]     = litros;
  payloadDoc["bombaLigada"] = STATUS_BOMBA;

  String payload;
  serializeJson(payloadDoc, payload);

  int httpCode = http.POST(payload);
  bool ok = false;

  if (httpCode == HTTP_CODE_OK) {
    String resposta = http.getString();

    JsonDocument doc;  // ArduinoJson 7.x; em 6.x use StaticJsonDocument<256>
    DeserializationError err = deserializeJson(doc, resposta);

    if (!err) {
      modoAtual   = doc["modo"]   | modoAtual;
      nivelMinimo = doc["minimo"] | nivelMinimo;
      nivelMaximo = doc["maximo"] | nivelMaximo;

      // Faixas de LED: vermelho abaixo do mínimo, amarelo até antes do
      // máximo e verde a partir do máximo.
      NIVEL_LED_VERMELHO = nivelMinimo;
      NIVEL_LED_VERDE    = nivelMaximo;

      // Executa o comando remoto diretamente apenas no modo manual.
      bool bombaCmd = doc["bombaLigada"] | STATUS_BOMBA;
      if (modoAtual == "manual" && bombaCmd != STATUS_BOMBA) {
        Serial.printf("Comando manual: bomba %s\n",
                      bombaCmd ? "LIGAR" : "DESLIGAR");
        acionarBomba(bombaCmd);
      }
      ok = true;
    } else {
      Serial.printf("JSON inválido: %s\n", err.c_str());
    }
  } else {
    Serial.printf("POST falhou. Código: %d\n", httpCode);
  }

  http.end();
  return ok;
}

// Envia nivel=-1 para informar falha do sensor; a API registra a falha
// e marca a bomba desligada. O corpo da resposta não é processado aqui.
void enviarFalhaParaServidor() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(client, URL_NIVEL)) {
    Serial.println("HTTPClient (falha): nao foi possivel iniciar requisicao.");
    return;
  }
  http.addHeader("Content-Type", "application/json");

  // Corpo JSON fixo para sinalizar falha, sem concatenações.
  String payload = "{\"nivel\":-1,\"litros\":0,\"bombaLigada\":false}";
  http.POST(payload);
  http.end();
}

/* INICIALIZAÇÃO DOS PINOS, ATUADORES E REDE */
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);
  pinMode(PINO_RELE, OUTPUT);
  for (int i = 0; i < 3; i++) pinMode(LEDS_NIVEL[i], OUTPUT);
  pinMode(LED_BOMBA, OUTPUT);

  digitalWrite(PINO_TRIG, LOW);
  acionarBomba(false);
  apagarLeds();

  conectarWiFi();

  Serial.println("Controlador iniciado.");
}

/* CICLO PRINCIPAL: medir, controlar, sincronizar e sinalizar */
void loop() {
  garantirWiFi();

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
    acionarBomba(false);
    apagarLeds();
    enviarFalhaParaServidor();
    return;
  }

  // 1. Automático: liga abaixo do mínimo e desliga acima do máximo.
  // O estado é atualizado antes do POST para refletir o relé no envio.
  if (modoAtual == "automatico") {
    if (!STATUS_BOMBA && nivel < nivelMinimo) {
      acionarBomba(true);
    } else if (STATUS_BOMBA && nivel > nivelMaximo) {
      acionarBomba(false);
    }
  }

  // 2. Pré-corte: desliga a bomba antes de enviar um nível >= 98%.
  if (STATUS_BOMBA && nivel >= NIVEL_CORTE_SEGURANCA) {
    Serial.printf(
                  "Pre-corte de seguranca: nivel %.1f%% >= %.0f%% - bomba DESLIGADA\n",
                  nivel, NIVEL_CORTE_SEGURANCA);

    acionarBomba(false);
  }

  // 3. Envia a medição e recebe configurações/comando na mesma requisição.
  float litros = nivel * CAPACIDADE_LITROS / 100.0f;
  bool comunicacaoServidorOK = enviarDadosParaServidor(nivel, litros);

  // Em modo manual, a falha na comunicação desliga a bomba localmente.
  if (!comunicacaoServidorOK && modoAtual == "manual" && STATUS_BOMBA) {
    Serial.println(
                   "Servidor indisponivel: bomba DESLIGADA no modo manual devido a queda do servidor."
                  );
    acionarBomba(false);
  }

  // 4. Pós-corte: bloqueia eventual comando manual recebido acima do limite.
  if (STATUS_BOMBA && nivel >= NIVEL_CORTE_SEGURANCA) {
    Serial.printf(
                  "Corte de seguranca local: nivel %.1f%% >= %.0f%% - bomba DESLIGADA\n",
                  nivel, NIVEL_CORTE_SEGURANCA
                 );

    acionarBomba(false);
  }

  // 5. Atualiza os indicadores de nível.
  atualizarLedsNivel(nivel);

  // 6. Registra medição e estado atual no monitor serial.
  Serial.printf(
                "Dist: %.1f cm | Nivel: %.1f%% | Bomba: %s | Modo: %s\n",
                distancia, nivel,
                STATUS_BOMBA ? "LIGADA" : "DESLIGADA",
                modoAtual.c_str()
               );
}
