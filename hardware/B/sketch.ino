#include <WiFi.h>

// ===============================
// PINOS
// ===============================

#define TRIG 13
#define ECHO 35
#define RELE 19

#define LED_VERMELHO 18
#define LED_AMARELO 17
#define LED_AZUL 16
#define LED_VERDE 4

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
float nivel = 0;

bool bombaLigada = false;

// true = automático
// false = manual
bool modoAutomatico = true;

// ===============================
// CONFIGURAÇÃO DO RELÉ
// ===============================

// false = relé ativo em HIGH
// true = relé ativo em LOW
const bool RELE_ATIVO_EM_LOW = false;

// ===============================
// CONFIGURAÇÃO DO RESERVATÓRIO
// ===============================

// Ajustar conforme as medidas reais do reservatório
float DIST_VAZIO_CM = 40.0;
float DIST_CHEIO_CM = 10.0;

// ===============================
// LIMITES DA BOMBA
// ===============================

float NIVEL_LIGA_BOMBA = 25.0;
float NIVEL_DESLIGA_BOMBA = 90.0;

// ===============================
// PROTEÇÃO DA BOMBA
// ===============================

unsigned long TIMEOUT_BOMBA_MS = 2UL * 60UL * 1000UL;
unsigned long COOLDOWN_BOMBA_MS = 5UL * 60UL * 1000UL;

unsigned long tempoLigadaBomba = 0;
unsigned long tempoUltimoTimeout = 0;

bool emCooldown = false;

// ===============================
// LIMITES DOS LEDS
// ===============================

float NIVEL_LED_VERMELHO = 25.0;
float NIVEL_LED_VERDE = 70.0;

// ===============================
// MEDIR DISTÂNCIA
// ===============================

float medirDistancia() {

  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG, LOW);

  unsigned long tempo = pulseIn(ECHO, HIGH, 30000UL);

  if (tempo == 0) {
    return -1.0;
  }

  return (tempo * 0.0343) / 2.0;
}

// ===============================
// CONVERTER DISTÂNCIA EM NÍVEL
// ===============================

float distanciaParaNivel(float distanciaAtual) {

  if (distanciaAtual < 0) {
    return -1.0;
  }

  float nivelCalculado =
    (DIST_VAZIO_CM - distanciaAtual) /
    (DIST_VAZIO_CM - DIST_CHEIO_CM) * 100.0;

  if (nivelCalculado < 0) {
    nivelCalculado = 0;
  }

  if (nivelCalculado > 100) {
    nivelCalculado = 100;
  }

  return nivelCalculado;
}

// ===============================
// ACIONAR BOMBA
// ===============================

void acionarBomba(bool ligar) {

  if (bombaLigada == ligar) {
    digitalWrite(LED_AZUL, ligar ? HIGH : LOW);
    return;
  }

  bombaLigada = ligar;

  if (ligar) {
    tempoLigadaBomba = millis();
  }

  if (RELE_ATIVO_EM_LOW) {

    digitalWrite(
                 RELE,
                 ligar ? LOW : HIGH
                );

  } else {

    digitalWrite(
                 RELE,
                 ligar ? HIGH : LOW
                );
  }

  // LED azul acompanha o estado da bomba
  digitalWrite(
               LED_AZUL,
               ligar ? HIGH : LOW
              );

  if (ligar) {
    Serial.println("Bomba LIGADA");
  } else {
    Serial.println("Bomba DESLIGADA");
  }
}

// ===============================
// DESLIGAR LEDS
// ===============================

void desligarLeds() {

  digitalWrite(LED_VERMELHO, LOW);
  digitalWrite(LED_AMARELO, LOW);
  digitalWrite(LED_VERDE, LOW);
  digitalWrite(LED_AZUL, LOW);
}

// ===============================
// ATUALIZAR LEDS DE NÍVEL
// ===============================

void atualizarLedsNivel(float nivelAtual) {

  digitalWrite(
               LED_VERMELHO,
               nivelAtual < NIVEL_LED_VERMELHO ? HIGH : LOW
              );

  digitalWrite(
               LED_AMARELO,
               (
                nivelAtual >= NIVEL_LED_VERMELHO &&
                nivelAtual < NIVEL_LED_VERDE
               ) ? HIGH : LOW
              );

  digitalWrite(
               LED_VERDE,
               nivelAtual >= NIVEL_LED_VERDE ? HIGH : LOW
              );

  // LED azul sempre acompanha a bomba
  digitalWrite(
               LED_AZUL,
               bombaLigada ? HIGH : LOW
              );
}

// ===============================
// VERIFICAR COOLDOWN
// ===============================

void verificarCooldown() {

  if (!emCooldown) {
    return;
  }

  if (
      millis() - tempoUltimoTimeout >=
      COOLDOWN_BOMBA_MS
     ) {

    emCooldown = false;

    Serial.println(
                   "Cooldown terminado. Sistema liberado."
                  );
  }
}

// ===============================
// VERIFICAR TIMEOUT DA BOMBA
// ===============================

void verificarTimeoutBomba() {

  if (!bombaLigada) {
    return;
  }

  if (
      millis() - tempoLigadaBomba >=
      TIMEOUT_BOMBA_MS
     ) {

    acionarBomba(false);

    emCooldown = true;
    tempoUltimoTimeout = millis();

    Serial.println(
                   "ALERTA: timeout da bomba!"
                  );

    Serial.println(
                   "Possivel bomba seca, entupimento ou falha."
                  );

    Serial.println(
                   "Bomba desligada e sistema em cooldown."
                  );
  }
}

// ===============================
// CONTROLE AUTOMÁTICO LOCAL
// ===============================

void controleAutomaticoLocal() {

  if (!modoAutomatico) {
    return;
  }

  if (nivel < 0) {

    Serial.println(
                   "Falha na leitura do sensor."
                  );

    acionarBomba(false);

    return;
  }

  verificarCooldown();
  verificarTimeoutBomba();

  if (emCooldown) {
    return;
  }

  // Reservatório com nível baixo
  if (
      !bombaLigada &&
      nivel < NIVEL_LIGA_BOMBA
     ) {

    Serial.println(
                   "AUTOMATICO: Nivel baixo"
                  );

    acionarBomba(true);
  }

  // Reservatório abastecido
  else if (
           bombaLigada &&
           nivel > NIVEL_DESLIGA_BOMBA
          ) {

    Serial.println(
                   "AUTOMATICO: Nivel maximo atingido"
                  );

    acionarBomba(false);
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

  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(LED_AMARELO, OUTPUT);
  pinMode(LED_AZUL, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);

  digitalWrite(TRIG, LOW);

  // Estado inicial seguro
  bombaLigada = false;

  if (RELE_ATIVO_EM_LOW) {
    digitalWrite(RELE, HIGH);
  } else {
    digitalWrite(RELE, LOW);
  }

  desligarLeds();

  Serial.println();
  Serial.println("==============================");
  Serial.println(" AQUALEVEL");
  Serial.println("==============================");

  Serial.println();
  Serial.println("Circuito configurado:");

  Serial.println("TRIG -> GPIO 13");
  Serial.println("ECHO -> GPIO 35");
  Serial.println("RELE -> GPIO 19");

  Serial.println("LED VERMELHO -> GPIO 18");
  Serial.println("LED AMARELO -> GPIO 17");
  Serial.println("LED AZUL -> GPIO 16");
  Serial.println("LED VERDE -> GPIO 4");

  Serial.println();

  // ===============================
  // CRIA REDE WIFI LOCAL
  // ===============================

  WiFi.softAP(ssid, password);

  IPAddress IP = WiFi.softAPIP();

  Serial.println(
                 "Rede local AquaLevel criada."
                );

  Serial.print("Nome da rede: ");
  Serial.println(ssid);

  Serial.print("IP local: http://");
  Serial.println(IP);

  server.begin();

  Serial.println(
                 "Servidor web local iniciado."
                );

  Serial.println(
                 "Controle automatico funciona independentemente do Wi-Fi."
                );
}

// ===============================
// LOOP
// ===============================

void loop() {

  // ==========================================
  // LEITURA DO SENSOR
  // ==========================================

  distancia = medirDistancia();

  nivel = distanciaParaNivel(distancia);

  // ==========================================
  // TRATAMENTO DE FALHA DO SENSOR
  // ==========================================

  if (distancia < 0) {

    Serial.println(
                   "Falha na leitura do HC-SR04."
                  );

    acionarBomba(false);

    desligarLeds();

  } else {

    // ==========================================
    // CONTROLE LOCAL
    // ==========================================

    verificarCooldown();
    verificarTimeoutBomba();

    controleAutomaticoLocal();

    atualizarLedsNivel(nivel);

    // ==========================================
    // LOG SERIAL
    // ==========================================

    Serial.print("Distancia: ");
    Serial.print(distancia, 1);

    Serial.print(" cm | Nivel: ");
    Serial.print(nivel, 1);

    Serial.print("% | Bomba: ");

    Serial.print(
                 bombaLigada ?
                 "LIGADA" :
                 "DESLIGADA"
                );

    Serial.print(" | Modo: ");

    Serial.println(
                   modoAutomatico ?
                   "AUTOMATICO" :
                   "MANUAL"
                  );
  }

  // ==========================================
  // SERVIDOR WEB LOCAL
  // ==========================================

  WiFiClient client = server.available();

  if (client) {

    String request = "";

    unsigned long tempoInicio = millis();

    while (
           client.connected() &&
           millis() - tempoInicio < 1000
          ) {

      if (client.available()) {

        char c = client.read();

        request += c;

        if (c == '\n') {

          // ==================================
          // BOTÃO LIGAR BOMBA
          // ==================================

          if (
              request.indexOf(
                              "GET /ligar"
                             ) >= 0
             ) {

            modoAutomatico = false;

            acionarBomba(true);

            Serial.println();
            Serial.println("MODO MANUAL");

            Serial.println(
                           "Bomba LIGADA pelo site"
                          );
          }

          // ==================================
          // BOTÃO DESLIGAR BOMBA
          // ==================================

          if (
              request.indexOf(
                              "GET /desligar"
                             ) >= 0
             ) {

            modoAutomatico = false;

            acionarBomba(false);

            Serial.println();
            Serial.println("MODO MANUAL");

            Serial.println(
                           "Bomba DESLIGADA pelo site"
                          );
          }

          // ==================================
          // BOTÃO MODO AUTOMÁTICO
          // ==================================

          if (
              request.indexOf(
                              "GET /automatico"
                             ) >= 0
             ) {

            modoAutomatico = true;

            Serial.println();

            Serial.println(
                           "MODO AUTOMATICO ATIVADO"
                          );

            distancia = medirDistancia();

            nivel =
              distanciaParaNivel(
                                 distancia
                                );

            controleAutomaticoLocal();
          }

          // ==================================
          // PÁGINA HTML
          // ==================================

          client.println(
                         "HTTP/1.1 200 OK"
                        );

          client.println(
                         "Content-type:text/html"
                        );

          client.println(
                         "Connection: close"
                        );

          client.println();

          client.println(
                         "<!DOCTYPE html>"
                        );

          client.println("<html>");

          client.println("<head>");

          client.println(
                         "<meta name='viewport' content='width=device-width, initial-scale=1'>"
                        );

          client.println(
                         "<meta http-equiv='refresh' content='3'>"
                        );

          client.println(
                         "<title>AquaLevel ESP32</title>"
                        );

          client.println("<style>");

          client.println("body {");

          client.println(
                         "font-family: Arial;"
                        );

          client.println(
                         "text-align: center;"
                        );

          client.println(
                         "background-color: #f2f2f2;"
                        );

          client.println(
                         "padding: 30px;"
                        );

          client.println("}");

          client.println(".caixa {");

          client.println(
                         "background: white;"
                        );

          client.println(
                         "padding: 25px;"
                        );

          client.println(
                         "border-radius: 15px;"
                        );

          client.println(
                         "max-width: 500px;"
                        );

          client.println(
                         "margin: auto;"
                        );

          client.println("}");

          client.println("button {");

          client.println(
                         "padding: 15px 25px;"
                        );

          client.println(
                         "font-size: 17px;"
                        );

          client.println(
                         "margin: 8px;"
                        );

          client.println(
                         "border-radius: 8px;"
                        );

          client.println(
                         "border: none;"
                        );

          client.println(
                         "cursor: pointer;"
                        );

          client.println("}");

          client.println("</style>");

          client.println("</head>");

          client.println("<body>");

          client.println(
                         "<div class='caixa'>"
                        );

          // ==================================
          // TÍTULO
          // ==================================

          client.println(
                         "<h1>AquaLevel</h1>"
                        );

          // ==================================
          // NÍVEL
          // ==================================

          client.println(
                         "<h2>Nivel da agua</h2>"
                        );

          if (nivel >= 0) {

            client.print("<h1>");

            client.print(
                         nivel,
                         1
                        );

            client.println(
                           "%</h1>"
                          );

            client.print(
                         "<p>Distancia: "
                        );

            client.print(
                         distancia,
                         1
                        );

            client.println(
                           " cm</p>"
                          );

          } else {

            client.println(
                           "<h2>Erro na leitura do sensor</h2>"
                          );
          }

          // ==================================
          // MODO
          // ==================================

          client.println(
                         "<h2>Modo de funcionamento</h2>"
                        );

          if (modoAutomatico) {

            client.println(
                           "<h2>MODO AUTOMATICO</h2>"
                          );

          } else {

            client.println(
                           "<h2>MODO MANUAL</h2>"
                          );
          }

          // ==================================
          // STATUS DA BOMBA
          // ==================================

          client.println(
                         "<h2>Status da bomba</h2>"
                        );

          if (bombaLigada) {

            client.println(
                           "<h2>BOMBA LIGADA</h2>"
                          );

          } else {

            client.println(
                           "<h2>BOMBA DESLIGADA</h2>"
                          );
          }

          // ==================================
          // COOLDOWN
          // ==================================

          if (emCooldown) {

            client.println(
                           "<p>Protecao da bomba: COOLDOWN</p>"
                          );
          }

          // ==================================
          // BOTÕES
          // ==================================

          client.println(
                         "<a href='/ligar'>"
                        );

          client.println(
                         "<button>LIGAR BOMBA</button>"
                        );

          client.println("</a>");

          client.println(
                         "<a href='/desligar'>"
                        );

          client.println(
                         "<button>DESLIGAR BOMBA</button>"
                        );

          client.println("</a>");

          client.println("<br>");

          client.println(
                         "<a href='/automatico'>"
                        );

          client.println(
                         "<button>MODO AUTOMATICO</button>"
                        );

          client.println("</a>");

          // ==================================
          // IP LOCAL
          // ==================================

          IPAddress IP =
            WiFi.softAPIP();

          client.println("<hr>");

          client.println(
                         "<p>Endereco local:</p>"
                        );

          client.print(
                       "<strong>http://"
                      );

          client.print(IP);

          client.println(
                         "</strong>"
                        );

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

  delay(300);
}
