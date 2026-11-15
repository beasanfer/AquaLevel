#include <Arduino.h>
#include <algorithm>

/* ==================== PINOS ==================== */

#define PINO_TRIG       13
#define PINO_ECHO       35 // input-only, exige divisor de tensão
#define PINO_RELE       19

// LED da bomba (azul), separado dos LEDs de nível
#define LED_BOMBA       4

// LEDs de nível (a ordem importa: 0 = baixo, 1 = médio, 2 = cheio)
const int LEDS_NIVEL[3] = {18, 17, 16};  // vermelho, amarelo, verde


/* ==================== CONFIGURAÇÃO ==================== */

// Relé: true = liga em LOW, false = liga em HIGH
const bool RELE_ATIVO_EM_LOW = true;

// Reservatório: distância do sensor (em cm) para 0% e 100%
float ALTURA_RESERVATORIO_CM = 22.5f; // fundo -> sensor
float NIVEL_DESEJADO_CM      = 5.0f;  // fundo -> nível desejado

// Histerese da bomba (em %)
float NIVEL_LIGA_BOMBA    = 60.0f;
float NIVEL_DESLIGA_BOMBA = 99.0f;

// Faixas dos LEDs de nível (em %)
float NIVEL_LED_VERMELHO = 25.0f;
float NIVEL_LED_VERDE    = 70.0f;

// Filtro e cadência de leitura
const int NUMERO_AMOSTRAS = 7; // 21 // ímpar, quanto maior, mais estável
                               // manter baixo se a vazão é lenta
const unsigned long INTERVALO_LEITURA_MS = 1000UL;


/* ==================== ESTADO ==================== */

bool STATUS_BOMBA = false;
unsigned long TEMPO_ULTIMA_LEITURA = 0;

// Estados possíveis dos LEDs de nível
enum EstadoNivel { BAIXO = 0, MEDIO = 1, CHEIO = 2 };


/* ==================== MEDIÇÃO ==================== */

unsigned long timeoutPulseIn() {
  return 30000UL; // 30 ms
}


// Faz uma leitura crua do HC-SR04
float lerDistanciaCrua() {
  digitalWrite(PINO_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PINO_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PINO_TRIG, LOW);

  unsigned long duracao = pulseIn(PINO_ECHO, HIGH, timeoutPulseIn());
  if (duracao == 0) return -1.0;

  // velocidade do som: 0,0343 cm/us a 20°C; divide por 2 (ida e volta)
  return (duracao * 0.0343) / 2.0;
}


// Tira várias amostras e devolve a mediana, descartando leituras inválidas.
float lerDistanciaFiltrada() {
  float leituras[NUMERO_AMOSTRAS];
  int validas = 0;

  for (int i = 0; i < NUMERO_AMOSTRAS; i++) {
    float d = lerDistanciaCrua();

    if (d > 0) {
      leituras[validas] = d;
      ++validas;
    }

    if (i < NUMERO_AMOSTRAS - 1) delay(60);
  }

  if (validas == 0) return -1.0;

  std::sort(leituras, leituras + validas);
  return leituras[validas / 2];
}


// Converte distância (cm) em nível (%), com os limites da configuração.
float distanciaParaNivel(float distancia) {
  if (distancia < 0) return -1.0;

  float nivel =
    (ALTURA_RESERVATORIO_CM - distancia) / NIVEL_DESEJADO_CM * 100.0;

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


// Apaga todos os LEDs de nível e o da bomba
void apagarLeds() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(LEDS_NIVEL[i], LOW);
  }

  digitalWrite(LED_BOMBA, LOW);
}


// Acende somente o LED correspondente ao estado atual
void atualizarLedsNivel(float nivel) {
  EstadoNivel estado;

  if (nivel < NIVEL_LED_VERMELHO) {
    estado = BAIXO;
  } else if (nivel < NIVEL_LED_VERDE) {
    estado = MEDIO;
  } else {
    estado = CHEIO;
  }

  for (int i = 0; i < 3; i++) {
    digitalWrite(LEDS_NIVEL[i], i == estado ? HIGH : LOW);
  }
}


/* ==================== SETUP ==================== */

void setup() {
  Serial.begin(9600);
  delay(1000);

  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);
  pinMode(PINO_RELE, OUTPUT);

  for (int i = 0; i < 3; i++) {
    pinMode(LEDS_NIVEL[i], OUTPUT);
  }
  pinMode(LED_BOMBA, OUTPUT);

  digitalWrite(PINO_TRIG, LOW);
  acionarBomba(false);
  apagarLeds();

  Serial.println("Controlador de nivel com ESP32 iniciado.");
  Serial.println("Leitura filtrada a cada 1 segundo.");
}


/* ==================== LOOP ==================== */

void loop() {
  // Aguarda o intervalo entre leituras
  if (millis() - TEMPO_ULTIMA_LEITURA < INTERVALO_LEITURA_MS) {
    delay(1); // evitar reinicialização por watchdog
    return;   // não passou, volta
  }

  TEMPO_ULTIMA_LEITURA = millis(); // passou

  float distancia = lerDistanciaFiltrada();
  float nivel     = distanciaParaNivel(distancia);

  // Falha na leitura: desliga tudo por segurança
  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");

    acionarBomba(false);
    apagarLeds();

    return;
  }

  // Controle da bomba com histerese
  if (!STATUS_BOMBA && nivel < NIVEL_LIGA_BOMBA) {
    acionarBomba(true);
  } else if (STATUS_BOMBA && nivel > NIVEL_DESLIGA_BOMBA) {
    acionarBomba(false);
  }

  atualizarLedsNivel(nivel);

  // Log
  Serial.print("Distancia: ");
  Serial.print(distancia, 1);
  Serial.print(" cm | Nivel: ");
  Serial.print(nivel, 1);
  Serial.print(" % | Bomba: ");
  Serial.println(STATUS_BOMBA ? "LIGADA" : "DESLIGADA");
}
