#include <Arduino.h>

/* ==================== PINOS ==================== */

#define PINO_TRIG  9
#define PINO_ECHO  10

/* ==================== CONFIGURAÇÃO ==================== */

const int NUMERO_AMOSTRAS = 7;   // ímpar, quanto maior, mais estável

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

// Insertion sort — substitui std::sort, que não existe no AVR
void ordenar(float *v, int n) {
  for (int i = 1; i < n; i++) {
    float chave = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > chave) {
      v[j + 1] = v[j];
      j--;
    }
    v[j + 1] = chave;
  }
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

  ordenar(leituras, validas);
  return leituras[validas / 2];
}

/* ==================== SETUP ==================== */

void setup() {
  Serial.begin(9600);
  delay(1000);

  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);
  digitalWrite(PINO_TRIG, LOW);

  Serial.println("Leitor HC-SR04 iniciado.");
}

/* ==================== LOOP ==================== */

void loop() {
  float distancia = lerDistanciaFiltrada();

  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");
  } else {
    Serial.print("Distancia: ");
    Serial.print(distancia, 1);
    Serial.println(" cm");
  }

  delay(1000);
}