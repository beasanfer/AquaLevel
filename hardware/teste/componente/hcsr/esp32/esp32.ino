#include <Arduino.h>
#include <algorithm>

/* ==================== PINOS ==================== */

#define PINO_TRIG  13
#define PINO_ECHO  35  // input-only no ESP32, exige divisor de tensão

/* ==================== CONFIGURAÇÃO ==================== */

// Reservatório: distância do sensor (cm) para 0% e 100%
float ALTURA_RESERVATORIO_CM = 22.5f;  // fundo -> sensor
float NIVEL_DESEJADO_CM      = 5.0f;   // fundo -> nível desejado

// Filtro e cadência de leitura
const int NUMERO_AMOSTRAS = 7;          // ímpar; quanto maior, mais estável
const unsigned long INTERVALO_LEITURA_MS = 1000UL;

/* ==================== MEDIÇÃO ==================== */

unsigned long timeoutPulseIn() {
  return 30000UL;  // 30 ms
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

// Tira várias amostras e devolve a mediana, descartando leituras inválidas
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

// Converte distância (cm) em nível (%), com os limites da configuração
float distanciaParaNivel(float distancia) {
  if (distancia < 0) return -1.0;

  float nivel =
    (ALTURA_RESERVATORIO_CM - distancia) / NIVEL_DESEJADO_CM * 100.0;

  if (nivel < 0)   nivel = 0;
  if (nivel > 100) nivel = 100;

  return nivel;
}

/* ==================== SETUP ==================== */

void setup() {
  Serial.begin(9600);
  delay(1000);

  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);
  digitalWrite(PINO_TRIG, LOW);

  Serial.println("Leitura HC-SR04 iniciada.");
}

/* ==================== LOOP ==================== */

void loop() {
  static unsigned long tempoUltimaLeitura = 0;

  if (millis() - tempoUltimaLeitura < INTERVALO_LEITURA_MS) {
    delay(1);  // evita watchdog
    return;
  }
  tempoUltimaLeitura = millis();

  float distancia = lerDistanciaFiltrada();
  float nivel     = distanciaParaNivel(distancia);

  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");
    return;
  }

  Serial.print("Distancia: ");
  Serial.print(distancia, 1);
  Serial.print(" cm | Nivel: ");
  Serial.print(nivel, 1);
  Serial.println(" %");
}