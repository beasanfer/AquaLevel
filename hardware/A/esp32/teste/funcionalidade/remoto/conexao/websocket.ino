#include <WiFi.h>
#include <WebSocketsClient.h>

/* ==================== GLOBAIS ==================== */

// ---------- Credenciais Wi-Fi ----------
const char* ssid     = "SEU_WIFI_SSID";
const char* password = "SUA_SENHA_WIFI";

// ---------- Servidor WebSocket ----------
const char* ws_host = "192.168.1.100";   // <-- Substitua pelo IP do seu servidor
const uint16_t ws_port = 8080;           // <-- Substitua pela porta do seu servidor
const char* ws_path = "/";               // path do endpoint, se houver

WebSocketsClient webSocket;

// ---------- Callback de eventos do WebSocket ----------
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Desconectado do servidor.");
      break;

    case WStype_CONNECTED:
      Serial.printf("[WS] Conectado a %s:%u%s\n", ws_host, ws_port, ws_path);
      // Opcional: enviar uma mensagem de teste assim que conectar
      webSocket.sendTXT("Ola do ESP32!");
      break;

    case WStype_TEXT:
      Serial.printf("[WS] Mensagem recebida: %s\n", payload);
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(9600);
  delay(1000);
  Serial.println("\n--- Teste de conexão WebSocket ESP32 ---");

  // 1. Conectar ao Wi-Fi
  Serial.printf("Conectando ao Wi-Fi: %s\n", ssid);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWi-Fi conectado!");
  Serial.print("IP local do ESP32: ");
  Serial.println(WiFi.localIP());

  // 2. Configurar o cliente WebSocket
  webSocket.begin(ws_host, ws_port, ws_path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000); // Tenta reconectar a cada 5 segundos
}

void loop() {
  webSocket.loop(); // Essencial para manter a conexão viva e processar eventos
}
