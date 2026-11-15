#include <Arduino.h>
#include <algorithm>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* ==================== PINOS ==================== */
#define PINO_TRIG       13
#define PINO_ECHO       35
#define PINO_RELE       19
#define LED_BOMBA       4
const int LEDS_NIVEL[3] = {18, 17, 16};

/* ==================== WIFI / SERVIDOR ==================== */
// >>> SUBSTITUA PELOS SEUS VALORES REAIS <<<
const char* WIFI_SSID  = "RODRIGUES";
const char* WIFI_SENHA = "Lima44@36";
const char* URL_NIVEL  = "http://192.168.0.20:3000/api/nivel";

/* ==================== CONFIGURAÇÃO ==================== */
const bool RELE_ATIVO_EM_LOW = true;

// ALTURA_RESERVATORIO_CM = distância do sensor até o fundo (tanque vazio)
// GAP_SENSOR_CM          = distância mínima sensor↔água (tanque cheio)
// Curso útil do sensor   = (ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM)
float ALTURA_RESERVATORIO_CM = 22.5f;
float GAP_SENSOR_CM          = 5.0f;

const float CAPACIDADE_LITROS = 1000.0f;

// Limites iniciais — sobrescritos pelo servidor via piggyback
float nivelMinimo = 30.0f;
float nivelMaximo = 90.0f;

// Limiares dos LEDs — sincronizados dinamicamente com minimo/maximo do
// servidor (ver enviarDadosParaServidor). Defaults alinhados com o
// estadoPadrao do servidor (30 / 90).
float NIVEL_LED_VERMELHO = 30.0f;
float NIVEL_LED_VERDE    = 90.0f;

/* CORTE DE SEGURANÇA UNIVERSAL
 * Aplica-se em QUALQUER modo (inclusive manual) e inclusive quando o
 * ESP32 está offline — o servidor pode estar inalcançável, mas a bomba
 * nunca deve permanecer ligada acima deste nível.
 *
 * Este valor DEVE coincidir com LIMITE_SEGURANCA_MANUAL em server.js.
 * Comportamento combinado:
 *   - Online  → servidor também corta (alerta "corte_seguranca").
 *   - Offline → corte local aqui evita transbordamento.
 *   - Ao reconectar, o servidor recebe bombaLigada=false e aplica seu
 *     próprio corte no próximo POST (sistema.nivel ≥ 98) — sem oscilação.
 */
const float NIVEL_CORTE_SEGURANCA = 98.0f;

const int NUMERO_AMOSTRAS = 7;
const unsigned long INTERVALO_LEITURA_MS = 1000UL;

/* ==================== ESTADO ==================== */
bool STATUS_BOMBA = false;
String modoAtual = "automatico";
unsigned long TEMPO_ULTIMA_LEITURA = 0;

enum EstadoNivel { BAIXO = 0, MEDIO = 1, CHEIO = 2 };

/* ==================== WIFI ==================== */
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
  static unsigned long ultimaTentativa = 0;
  if (millis() - ultimaTentativa < 5000) return;
  ultimaTentativa = millis();
  Serial.println("WiFi caiu. Reconectando...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
}

/* ==================== MEDIÇÃO ==================== */
unsigned long timeoutPulseIn() { return 30000UL; }

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

float distanciaParaNivel(float distancia) {
  if (distancia < 0) return -1.0;

  // Normaliza pelo curso útil do sensor (não pelo gap absoluto).
  // Tanque vazio (dist = ALTURA) → 0%
  // Tanque cheio (dist = GAP)    → 100%
  float nivel = (ALTURA_RESERVATORIO_CM - distancia)
    / (ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM) * 100.0;

  if (nivel < 0)   nivel = 0;
  if (nivel > 100) nivel = 100;
  return nivel;
}

/* ==================== ATUADORES ==================== */
void acionarBomba(bool ligar) {
  STATUS_BOMBA = ligar;
  digitalWrite(PINO_RELE, ligar == RELE_ATIVO_EM_LOW ? LOW : HIGH);
  digitalWrite(LED_BOMBA, ligar ? HIGH : LOW);
}

void apagarLeds() {
  for (int i = 0; i < 3; i++) digitalWrite(LEDS_NIVEL[i], LOW);
  digitalWrite(LED_BOMBA, LOW);
}

void atualizarLedsNivel(float nivel) {
  EstadoNivel estado;
  if (nivel < NIVEL_LED_VERMELHO)      estado = BAIXO;
  else if (nivel < NIVEL_LED_VERDE)    estado = MEDIO;
  else                                 estado = CHEIO;

  for (int i = 0; i < 3; i++)
    digitalWrite(LEDS_NIVEL[i], i == estado ? HIGH : LOW);
}

/* ==================== COMUNICAÇÃO (PIGGYBACK) ====================
 * Uma única requisição por ciclo:
 *   - envia a leitura (nivel, litros, bombaLigada) no POST
 *   - recebe o comando (modo, minimo, maximo, bombaLigada) na resposta
 * Retorna true se a troca foi bem-sucedida.
 * ================================================================ */
bool enviarDadosParaServidor(float nivel, float litros) {
  if (WiFi.status() != WL_CONNECTED) return false;

  /* 3.1: forma moderna do HTTPClient::begin — passa um WiFiClient
   * explícito em vez da sobrecarga deprecada http.begin(url).
   * O WiFiClient precisa permanecer vivo durante toda a requisição;
   * por isso é local e http.end() é chamado antes do retorno. */
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(client, URL_NIVEL)) {
    Serial.println("HTTPClient: falha ao iniciar requisicao.");
    return false;
  }
  http.addHeader("Content-Type", "application/json");

  String payload = String("{\"nivel\":") + String(nivel, 2) +
    ",\"litros\":" + String(litros, 1) +
    ",\"bombaLigada\":" + (STATUS_BOMBA ? "true" : "false") + "}";

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

      // Sincroniza limiares dos LEDs com os limites reais do servidor.
      // Isto faz o indicador físico refletir a MESMA semântica do
      // dashboard: vermelho < minimo ≤ amarelo < maximo ≤ verde.
      NIVEL_LED_VERMELHO = nivelMinimo;
      NIVEL_LED_VERDE    = nivelMaximo;

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

// Informa ao servidor que a leitura falhou (nivel = -1 ⇒ sensorOK = false).
// O servidor responde 200 com {sucesso:false, sensorOK:false}; o ESP32
// ignora o corpo — o efeito desejado já ocorre do lado servidor.
void enviarFalhaParaServidor() {
  if (WiFi.status() != WL_CONNECTED) return;

  /* 3.1: mesma migração — HTTPClient::begin(WiFiClient&, url). */
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(client, URL_NIVEL)) {
    Serial.println("HTTPClient (falha): nao foi possivel iniciar requisicao.");
    return;
  }
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"nivel\":-1,\"litros\":0,\"bombaLigada\":false}";
  http.POST(payload);
  http.end();
}

/* ==================== SETUP ==================== */
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

/* ==================== LOOP ==================== */
void loop() {
  garantirWiFi();

  if (millis() - TEMPO_ULTIMA_LEITURA < INTERVALO_LEITURA_MS) {
    delay(1);
    return;
  }
  TEMPO_ULTIMA_LEITURA = millis();

  float distancia = lerDistanciaFiltrada();
  float nivel     = distanciaParaNivel(distancia);

  // Falha na leitura: desliga tudo por segurança
  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");
    acionarBomba(false);
    apagarLeds();
    enviarFalhaParaServidor();
    return;
  }

  // 1) CONTROLE AUTOMÁTICO LOCAL — executado ANTES do envio para que o
  //    servidor receba o estado da bomba já atualizado neste ciclo.
  //    Corrige o espelhamento defasado de ~1s do STATUS_BOMBA no
  //    servidor (o POST anterior enviava o estado do ciclo anterior).
  if (modoAtual == "automatico") {
    if (!STATUS_BOMBA && nivel < nivelMinimo) {
      acionarBomba(true);
    } else if (STATUS_BOMBA && nivel > nivelMaximo) {
      acionarBomba(false);
    }
  }

  // 1.5) PRÉ-CORTE DE SEGURANÇA — item 3.3:
  //    Se o relé está ligado (por qualquer razão, inclusive comando
  //    manual recebido no ciclo anterior) e o nível já passou do limite,
  //    desliga AGORA — antes do POST — para que o servidor receba
  //    bombaLigada=false no MESMO ciclo em que o relé abre. Isso reduz
  //    a janela em que /api/status reporta "ligada" enquanto o relé
  //    físico já está aberto.
  if (STATUS_BOMBA && nivel >= NIVEL_CORTE_SEGURANCA) {
    Serial.printf(
                  "Pre-corte de seguranca: nivel %.1f%% >= %.0f%% - bomba DESLIGADA\n",
                  nivel, NIVEL_CORTE_SEGURANCA);
    acionarBomba(false);
  }

  // 2) Envia leitura E recebe comando na mesma requisição (piggyback).
  //    A resposta pode alterar modoAtual, nivelMinimo, nivelMaximo e,
  //    em modo manual, aplicar um comando do usuário.
  float litros = nivel * CAPACIDADE_LITROS / 100.0f;
  enviarDadosParaServidor(nivel, litros);

  // 3) CORTE DE SEGURANÇA UNIVERSAL — pós-POST, para vencer qualquer
  //    comando (inclusive manual) recebido no passo anterior.
  if (STATUS_BOMBA && nivel >= NIVEL_CORTE_SEGURANCA) {
    Serial.printf(
                  "Corte de seguranca local: nivel %.1f%% >= %.0f%% - bomba DESLIGADA\n",
                  nivel, NIVEL_CORTE_SEGURANCA);
    acionarBomba(false);
  }

  // 4) LEDs de nível
  atualizarLedsNivel(nivel);

  // 5) Log
  Serial.printf("Dist: %.1f cm | Nivel: %.1f%% | Bomba: %s | Modo: %s\n",
                distancia, nivel,
                STATUS_BOMBA ? "LIGADA" : "DESLIGADA",
                modoAtual.c_str());
}