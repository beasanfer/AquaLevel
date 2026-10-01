#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------- CONFIGURAÇÕES ----------
const char* ssid = "SEU_WIFI";
const char* password = "SUA_SENHA";
const char* servidor_host = "192.168.1.100"; // IP do seu computador
const int servidor_porta = 8080;

// Objeto WebSocket
WebSocketsClient webSocket;

// Variáveis de estado dos setpoints
float setpoint_temp = 0.0;
float setpoint_umid = 0.0;

// ---------- FUNÇÃO DE EVENTOS WEBSOCKET ----------
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {

  case WStype_DISCONNECTED:
    Serial.println("[WS] Desconectado. Tentando reconectar...");
    break;

  case WStype_CONNECTED:
    Serial.println("[WS] Conectado ao servidor!");
    // Envia uma mensagem de "hello" para identificar o dispositivo
    webSocket.sendTXT("{\"type\":\"hello\",\"device\":\"ESP32-01\"}");
    break;

  case WStype_TEXT: {
    Serial.printf("[WS] Mensagem recebida: %s\n", payload);

    // Faz o parse do JSON
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
      Serial.print("Erro no JSON: ");
      Serial.println(err.c_str());
      return;
    }

    const char* tipo = doc["type"];

    // ---------- RECEBEU UM SETPOINT ----------
    if (strcmp(tipo, "setpoint") == 0) {
      float temp = doc["temp"];
      float umid = doc["umid"];

      // Aplica o setpoint (aqui você colocaria a lógica real)
      setpoint_temp = temp;
      setpoint_umid = umid;

      Serial.printf("Setpoint atualizado: Temp=%.1f, Umid=%.1f\n", temp, umid);

      // Envia ACK de confirmação
      StaticJsonDocument<128> ack;
      ack["type"] = "ack";
      ack["id"] = doc["id"];  // devolve o mesmo ID
      ack["ok"] = true;

      String resposta;
      serializeJson(ack, resposta);
      webSocket.sendTXT(resposta);
    }

    // ---------- RECEBEU UM PEDIDO DE STATUS ----------
    if (strcmp(tipo, "get_status") == 0) {
      // Aqui você leria os sensores reais
      float temp_real = 24.5;
      float umid_real = 58.0;

      StaticJsonDocument<256> status;
      status["type"] = "status";
      status["id"] = doc["id"]; // devolve o mesmo ID
      status["temp"] = temp_real;
      status["umid"] = umid_real;
      status["modo"] = "auto";

      String resposta;
      serializeJson(status, resposta);
      webSocket.sendTXT(resposta);
    }

    break;
  }

  case WStype_ERROR:
    Serial.println("[WS] Erro na conexão.");
    break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  // ---------- CONEXÃO WI-FI ----------
  Serial.print("Conectando ao Wi-Fi...");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi conectado!");
  Serial.print("IP do ESP32: ");
  Serial.println(WiFi.localIP());

  // ---------- CONEXÃO WEBSOCKET ----------
  // Inicia a conexão com o servidor
  webSocket.begin(servidor_host, servidor_porta, "/");
  webSocket.onEvent(webSocketEvent);

  // Reconexão automática: tenta a cada 5 segundos se cair
  webSocket.setReconnectInterval(5000);

  // Heartbeat: envia ping a cada 15s, espera pong em 3s, desiste após 2 tentativas
  webSocket.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  // Mantém o WebSocket "vivo" e processando mensagens
  webSocket.loop();

  // Aqui você poderia colocar a lógica do seu controlador
  // (ler sensores, atuar em relés, etc.)
}
