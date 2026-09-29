#include <WiFi.h>

// ===============================
// PINOS
// ===============================

#define RELE 33
#define TRIG 26
#define ECHO 27

// ===============================
// WIFI LOCAL DO ESP32
// ===============================

const char* ssid = "AquaLevel";
const char* password = "aqualevel";

WiFiServer server(80);

// ===============================
// VARIÁVEIS
// ===============================

float distancia = 0;

bool bombaLigada = false;

// true = automático
// false = manual
bool modoAutomatico = true;

// ===============================
// MEDIR DISTÂNCIA
// ===============================

float medirDistancia() {

  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG, LOW);

  long tempo = pulseIn(ECHO, HIGH, 30000);

  if (tempo == 0) {
    return -1;
  }

  return tempo / 58.0;
}

// ===============================
// CONTROLE LOCAL DA BOMBA
// ===============================

void controleAutomaticoLocal() {

  if (!modoAutomatico) {
    return;
  }

  if (distancia <= 0) {
    Serial.println("Falha na leitura do sensor.");
    return;
  }

  // Reservatório cheio
  if (distancia <= 5 && bombaLigada) {

    digitalWrite(RELE, HIGH);
    bombaLigada = false;

    Serial.println("AUTOMATICO: Reservatorio CHEIO");
    Serial.println("Bomba DESLIGADA");
  }

  // Reservatório vazio
  else if (distancia >= 13 && !bombaLigada) {

    digitalWrite(RELE, LOW);
    bombaLigada = true;

    Serial.println("AUTOMATICO: Reservatorio VAZIO");
    Serial.println("Bomba LIGADA");
  }
}

// ===============================
// SETUP
// ===============================

void setup() {

  Serial.begin(115200);

  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  pinMode(RELE, OUTPUT);

  // Começa com a bomba desligada
  digitalWrite(RELE, HIGH);
  bombaLigada = false;

  Serial.println();
  Serial.println("==============================");
  Serial.println(" AQUALEVEL");
  Serial.println("==============================");

  // ===============================
  // CRIA REDE WIFI LOCAL
  // ===============================

  WiFi.softAP(ssid, password);

  IPAddress IP = WiFi.softAPIP();

  Serial.println();
  Serial.println("Rede local AquaLevel criada.");

  Serial.print("Nome da rede: ");
  Serial.println(ssid);

  Serial.print("IP local: http://");
  Serial.println(IP);

  server.begin();

  Serial.println("Servidor web local iniciado.");
  Serial.println("Controle automatico funciona independentemente do Wi-Fi.");
}

// ===============================
// LOOP
// ===============================

void loop() {

  // ==========================================
  // LEITURA DO SENSOR
  // ==========================================

  distancia = medirDistancia();

  // ==========================================
  // CONTROLE LOCAL
  // ==========================================
  // Esta função é executada independentemente
  // de existir cliente conectado ao Wi-Fi.

  controleAutomaticoLocal();

  // ==========================================
  // SERVIDOR WEB LOCAL
  // ==========================================

  WiFiClient client = server.available();

  if (client) {

    String request = "";

    unsigned long tempoInicio = millis();

    while (client.connected() && millis() - tempoInicio < 1000) {

      if (client.available()) {

        char c = client.read();
        request += c;

        if (c == '\n') {

          // ==================================
          // BOTÃO LIGAR BOMBA
          // ==================================

          if (request.indexOf("GET /ligar") >= 0) {

            modoAutomatico = false;

            digitalWrite(RELE, LOW);
            bombaLigada = true;

            Serial.println();
            Serial.println("MODO MANUAL");
            Serial.println("Bomba LIGADA pelo site");
          }

          // ==================================
          // BOTÃO DESLIGAR BOMBA
          // ==================================

          if (request.indexOf("GET /desligar") >= 0) {

            modoAutomatico = false;

            digitalWrite(RELE, HIGH);
            bombaLigada = false;

            Serial.println();
            Serial.println("MODO MANUAL");
            Serial.println("Bomba DESLIGADA pelo site");
          }

          // ==================================
          // BOTÃO MODO AUTOMÁTICO
          // ==================================

          if (request.indexOf("GET /automatico") >= 0) {

            modoAutomatico = true;

            Serial.println();
            Serial.println("MODO AUTOMATICO ATIVADO");

            distancia = medirDistancia();

            controleAutomaticoLocal();
          }

          // ==================================
          // PÁGINA HTML
          // ==================================

          client.println("HTTP/1.1 200 OK");
          client.println("Content-type:text/html");
          client.println("Connection: close");
          client.println();

          client.println("<!DOCTYPE html>");
          client.println("<html>");

          client.println("<head>");

          client.println("<meta name='viewport' content='width=device-width, initial-scale=1'>");
          client.println("<meta http-equiv='refresh' content='3'>");
          client.println("<title>AquaLevel ESP32</title>");

          client.println("<style>");
          client.println("body {");
          client.println("font-family: Arial;");
          client.println("text-align: center;");
          client.println("background-color: #f2f2f2;");
          client.println("padding: 30px;");
          client.println("}");

          client.println(".caixa {");
          client.println("background: white;");
          client.println("padding: 25px;");
          client.println("border-radius: 15px;");
          client.println("max-width: 500px;");
          client.println("margin: auto;");
          client.println("}");

          client.println("button {");
          client.println("padding: 15px 25px;");
          client.println("font-size: 17px;");
          client.println("margin: 8px;");
          client.println("border-radius: 8px;");
          client.println("border: none;");
          client.println("cursor: pointer;");
          client.println("}");
          client.println("</style>");

          client.println("</head>");

          client.println("<body>");
          client.println("<div class='caixa'>");

          // ==================================
          // TÍTULO
          // ==================================

          client.println("<h1>AquaLevel</h1>");

          // ==================================
          // DISTÂNCIA
          // ==================================

          client.println("<h2>Nivel da agua</h2>");

          if (distancia > 0) {

            client.print("<h1>");
            client.print(distancia);
            client.println(" cm</h1>");

          } else {

            client.println("<h2>Erro na leitura do sensor</h2>");
          }

          // ==================================
          // MODO
          // ==================================

          client.println("<h2>Modo de funcionamento</h2>");

          if (modoAutomatico) {

            client.println("<h2>MODO AUTOMATICO</h2>");

          } else {

            client.println("<h2>MODO MANUAL</h2>");
          }

          // ==================================
          // STATUS DA BOMBA
          // ==================================

          client.println("<h2>Status da bomba</h2>");

          if (bombaLigada) {

            client.println("<h2>BOMBA LIGADA</h2>");

          } else {

            client.println("<h2>BOMBA DESLIGADA</h2>");
          }

          // ==================================
          // BOTÕES
          // ==================================

          client.println("<a href='/ligar'>");
          client.println("<button>LIGAR BOMBA</button>");
          client.println("</a>");

          client.println("<a href='/desligar'>");
          client.println("<button>DESLIGAR BOMBA</button>");
          client.println("</a>");

          client.println("<br>");

          client.println("<a href='/automatico'>");
          client.println("<button>MODO AUTOMATICO</button>");
          client.println("</a>");

          // ==================================
          // IP LOCAL
          // ==================================

          IPAddress IP = WiFi.softAPIP();

          client.println("<hr>");
          client.println("<p>Endereco local:</p>");

          client.print("<strong>http://");
          client.print(IP);
          client.println("</strong>");

          client.println("</div>");
          client.println("</body>");
          client.println("</html>");
          client.println();

          break;
        }
      }
    }

    client.stop();
  }

  delay(500);
}