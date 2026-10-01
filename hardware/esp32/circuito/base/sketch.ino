#include <Arduino.h>

/*
Circuito

 HC-SR04:
   TRIG  -> GPIO 13
   ECHO  -> divisor de tensão (1k + 1,5k) -> GPIO 35
            (divisor reduz 5V do sensor para ~3V, seguro para o ESP32)
   VCC   -> 5V
   GND   -> GND

 Relé:
   IN    -> GPIO 19
   VCC   -> 5V
   GND   -> GND

 LEDs (com resistor de 220 ohm em série cada):
   Vermelho -> GPIO 18  (nível < 25%)
   Amarelo  -> GPIO 17  (25% <= nível < 70%)
   Verde    -> GPIO 4   (nível >= 70%)
   Azul     -> GPIO 16  (espelha o estado da bomba)
*/

/* =============== PINOS =================== */

#define PINO_TRIG       13
#define PINO_ECHO       35   // input-only + divisor externo
#define PINO_RELE       19

#define LED_VERMELHO    18
#define LED_AMARELO     17
#define LED_AZUL        16   // status da bomba
#define LED_VERDE        4


/* =========== VARIÁVEIS GLOBAIS =========== */

// Relé
// false = ativo em HIGH, true = ativo em LOW
const bool RELE_ATIVO_EM_LOW = false;
// --------------------------------------------

// Reservatório
// ajustar conforme o reservatório
float DIST_VAZIO_CM = 40.0;  // distância do sensor até o fundo
float DIST_CHEIO_CM = 10.0;  // distância do sensor até o nível cheio
// --------------------------------------------

// Bomba
bool STATUS_BOMBA = false; // true = ligada, false = desliga

// histerese da bomba
float NIVEL_LIGA_BOMBA    = 25.0; // em %
float NIVEL_DESLIGA_BOMBA = 90.0; // em %

// proteção por timeout
unsigned long TIMEOUT_BOMBA_MS  = 2UL * 60UL * 1000UL;  // 2 minutos
unsigned long COOLDOWN_BOMBA_MS = 5UL * 60UL * 1000UL; // 5 minutos

// auxiliares
unsigned long TEMPO_LIGADA_BOMBA = 0;
unsigned long TEMPO_ULTIMO_TIMEOUT = 0;
bool emCooldown = false;
// --------------------------------------------

// LEDs
// faixas dos LEDs de nível
float NIVEL_LED_VERMELHO = 25.0;  // < 25%  -> vermelho
float NIVEL_LED_VERDE    = 70.0;  // >= 70% -> verde
                                  // entre 25% e 70% -> amarelo


/* =============== FUNÇÕES ================= */

float medirDistanciaCm() {
  digitalWrite(PINO_TRIG, LOW);
  delayMicroseconds(2);

  digitalWrite(PINO_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PINO_TRIG, LOW);

  unsigned long duracao = pulseIn(PINO_ECHO, HIGH, 30000UL);

  if (duracao == 0) {
    return -1.0; // falha na leitura
  }

  // velocidade do som: 0,0343 cm/us
  return (duracao * 0.0343) / 2.0;
}


float distanciaParaNivel(float distancia) {
  if (distancia < 0) return -1.0;

  float nivel = (DIST_VAZIO_CM - distancia) /
    (DIST_VAZIO_CM - DIST_CHEIO_CM) * 100.0;

  if (nivel < 0) nivel = 0;
  if (nivel > 100) nivel = 100;

  return nivel;
}


void acionarBomba(bool ligar) {
  STATUS_BOMBA = ligar;

  if (ligar) {
    TEMPO_LIGADA_BOMBA = millis();
  }

  if (RELE_ATIVO_EM_LOW) {
    digitalWrite(PINO_RELE, ligar ? LOW : HIGH);
  } else {
    digitalWrite(PINO_RELE, ligar ? HIGH : LOW);
  }

  // LED azul espelha o estado da bomba
  digitalWrite(LED_AZUL, ligar ? HIGH : LOW);
}


void desligarLeds() {
  digitalWrite(LED_VERMELHO, LOW);
  digitalWrite(LED_AMARELO, LOW);
  digitalWrite(LED_VERDE, LOW);
  digitalWrite(LED_AZUL, LOW);
}


void atualizarLedsNivel(float nivel) {
  // vermelho: nível crítico (bomba ligada ou prestes a ligar)
  digitalWrite(LED_VERMELHO, nivel < NIVEL_LED_VERMELHO ? HIGH : LOW);

  // amarelo: faixa intermediária
  digitalWrite(LED_AMARELO,
               (nivel >= NIVEL_LED_VERMELHO && nivel < NIVEL_LED_VERDE) ? HIGH : LOW);

  // verde: reservatório abastecido
  digitalWrite(LED_VERDE, nivel >= NIVEL_LED_VERDE ? HIGH : LOW);
}


/* =============== COMEÇO ================== */
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT); // GPIO 35 é input-only
  pinMode(PINO_RELE, OUTPUT);

  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(LED_AMARELO, OUTPUT);
  pinMode(LED_AZUL, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);

  digitalWrite(PINO_TRIG, LOW);

  acionarBomba(false); // já apaga o azul também
  desligarLeds();

  Serial.println("Controlador de nivel com ESP32 iniciado.");
  Serial.print("Timeout da bomba: ");
  Serial.print(TIMEOUT_BOMBA_MS / 60000UL);
  Serial.print(" min | Cooldown apos falha: ");
  Serial.print(COOLDOWN_BOMBA_MS / 60000UL);
  Serial.println(" min.");
  Serial.println("LED azul = estado da bomba.");
}


/* =============== LÓGICA ================== */
void loop() {
  float distancia = medirDistanciaCm();
  float nivel = distanciaParaNivel(distancia);

  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");
    acionarBomba(false);
    desligarLeds();
    delay(500);
    return;
  }

  // verifica se o cooldown acabou
  if (emCooldown) {
    if (millis() - TEMPO_ULTIMO_TIMEOUT >= COOLDOWN_BOMBA_MS) {
      emCooldown = false;
      Serial.println("Cooldown terminado. Sistema liberado para nova tentativa.");
    }
  }

  // verifica timeout da bomba
  if (STATUS_BOMBA && (millis() - TEMPO_LIGADA_BOMBA >= TIMEOUT_BOMBA_MS)) {
    acionarBomba(false);
    emCooldown = true;
    TEMPO_ULTIMO_TIMEOUT = millis();

    Serial.println("ALERTA: timeout da bomba!");
    Serial.println("Possivel bomba seca, entupimento ou falha no sistema.");
    Serial.print("Bomba desligada. Entrando em cooldown por ");
    Serial.print(COOLDOWN_BOMBA_MS / 60000UL);
    Serial.println(" minutos.");
  }

  // controle da bomba com histerese (só se não estiver em cooldown)
  if (!emCooldown) {
    if (!STATUS_BOMBA && nivel < NIVEL_LIGA_BOMBA) {
      acionarBomba(true);
    }
    else if (STATUS_BOMBA && nivel > NIVEL_DESLIGA_BOMBA) {
      acionarBomba(false);
    }
  }

  // LEDs de nível (vermelho/amarelo/verde)
  atualizarLedsNivel(nivel);

  // log serial
  Serial.print("Distancia: ");
  Serial.print(distancia, 1);
  Serial.print(" cm | Nivel: ");
  Serial.print(nivel, 1);
  Serial.print(" % | Bomba: ");
  Serial.print(STATUS_BOMBA ? "LIGADA" : "DESLIGADA");

  if (STATUS_BOMBA) {
    Serial.print(" (ha ");
    Serial.print((millis() - TEMPO_LIGADA_BOMBA) / 1000UL);
    Serial.print("s)");
  }

  if (emCooldown) {
    unsigned long restante = (COOLDOWN_BOMBA_MS - (millis() - TEMPO_ULTIMO_TIMEOUT)) / 1000UL;
    Serial.print(" [COOLDOWN: ");
    Serial.print(restante);
    Serial.print("s]");
  }

  Serial.println();

  delay(300);
}
