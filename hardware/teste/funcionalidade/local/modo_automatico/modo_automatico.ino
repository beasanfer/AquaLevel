
#include <Arduino.h>
#include <algorithm>

/* ==================== PINOS ==================== */

#define PINO_TRIG       13
#define PINO_ECHO       35 // input-only, exige divisor de tensão
#define PINO_RELE       19

// LED da bomba (azul), separado dos LEDs de nível
#define LED_BOMBA       4

// LEDs de nível (0 = baixo, 1 = médio, 2 = cheio)
const int LEDS_NIVEL[3] = {18, 17, 16}; // vermelho, amarelo, verde


/* ==================== CONFIGURAÇÃO ==================== */

// Relé: true = liga em LOW, false = liga em HIGH
const bool RELE_ATIVO_EM_LOW = true;

// Reservatório: distância do sensor (em cm) para 0% e 100%
float ALTURA_RESERVATORIO_CM = 22.8f; // fundo -> sensor
float NIVEL_DESEJADO_CM      = 10.0f; // fundo -> nível desejado

// Histerese da bomba (em %)
float NIVEL_LIGA_BOMBA    = 60.0f;
float NIVEL_DESLIGA_BOMBA = 98.0f;

// Faixas dos LEDs de nível (em %)
float NIVEL_LED_VERMELHO = 25.0f;
float NIVEL_LED_VERDE    = 70.0f;

// Filtro e cadência de leitura
const int NUMERO_AMOSTRAS = 7; // ímpar
const unsigned long INTERVALO_LEITURA_MS = 1000UL;

// Tempo de espera ao iniciar o ESP32
const unsigned long TEMPO_INICIALIZACAO_MS = 10000UL;


/* ==================== ESTADO ==================== */

bool STATUS_BOMBA = false;
unsigned long TEMPO_ULTIMA_LEITURA = 0;

// Estados possíveis dos LEDs de nível
enum EstadoNivel {
  BAIXO = 0,
  MEDIO = 1,
  CHEIO = 2
};


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

  unsigned long duracao = pulseIn(
    PINO_ECHO,
    HIGH,
    timeoutPulseIn()
  );

  if (duracao == 0) {
    return -1.0f;
  }

  // Velocidade do som: 0,0343 cm/us a 20°C
  // Divide por 2 (ida e volta)
  return (duracao * 0.0343f) / 2.0f;
}


// Tira várias amostras e devolve a mediana,
// descartando leituras inválidas.
float lerDistanciaFiltrada() {
  float leituras[NUMERO_AMOSTRAS];
  int validas = 0;

  for (int i = 0; i < NUMERO_AMOSTRAS; i++) {
    float d = lerDistanciaCrua();

    if (d > 0) {
      leituras[validas] = d;
      ++validas;
    }

    if (i < NUMERO_AMOSTRAS - 1) {
      delay(60);
    }
  }

  if (validas == 0) {
    return -1.0f;
  }

  std::sort(leituras, leituras + validas);

  return leituras[validas / 2];
}


// Converte distância (cm) em nível (%)
float distanciaParaNivel(float distancia) {
  if (distancia < 0) {
    return -1.0f;
  }

  float nivel =
    (ALTURA_RESERVATORIO_CM - distancia) /
    NIVEL_DESEJADO_CM * 100.0f;

  if (nivel < 0) {
    nivel = 0;
  }

  if (nivel > 100) {
    nivel = 100;
  }

  return nivel;
}


/* ==================== ATUADORES ==================== */

void acionarBomba(bool ligar) {
  STATUS_BOMBA = ligar;

  digitalWrite(
    PINO_RELE,
    ligar == RELE_ATIVO_EM_LOW ? LOW : HIGH
  );

  digitalWrite(
    LED_BOMBA,
    ligar ? HIGH : LOW
  );
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
  }
  else if (nivel < NIVEL_LED_VERDE) {
    estado = MEDIO;
  }
  else {
    estado = CHEIO;
  }

  for (int i = 0; i < 3; i++) {
    digitalWrite(
      LEDS_NIVEL[i],
      i == estado ? HIGH : LOW
    );
  }
}


/* ==================== SETUP ==================== */

void setup() {
  Serial.begin(115200);

  // Inicializa o sensor ultrassônico
  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);

  // Prepara o nível lógico de desligamento
  // antes de configurar o pino do relé como saída.
  digitalWrite(
    PINO_RELE,
    RELE_ATIVO_EM_LOW ? HIGH : LOW
  );

  pinMode(PINO_RELE, OUTPUT);

  // Inicializa os LEDs de nível
  for (int i = 0; i < 3; i++) {
    pinMode(LEDS_NIVEL[i], OUTPUT);
  }

  // Inicializa o LED da bomba
  pinMode(LED_BOMBA, OUTPUT);

  // Garante o estado inicial seguro
  digitalWrite(PINO_TRIG, LOW);

  acionarBomba(false);
  apagarLeds();

  /* ===== ESPERA INICIAL DE 5 SEGUNDOS ===== */

  Serial.println();
  Serial.println("================================");
  Serial.println(" ESP32 - CONTROLE DE RESERVATORIO");
  Serial.println("================================");

  Serial.println("Inicializando sistema...");
  Serial.println("Bomba desligada.");
  Serial.println("LEDs desligados.");
  Serial.println("Aguardando 5 segundos...");

  // Durante este tempo, nenhuma medição
  // ou decisão de controle será realizada.
  delay(TEMPO_INICIALIZACAO_MS);

  // Permite a primeira leitura imediatamente
  // após o período de inicialização.
  TEMPO_ULTIMA_LEITURA =
    millis() - INTERVALO_LEITURA_MS;

  Serial.println();
  Serial.println("Inicializacao concluida!");
  Serial.println("Sistema liberado!");
  Serial.println("Leitura filtrada a cada 1 segundo.");
  Serial.println();
}


/* ==================== LOOP ==================== */

void loop() {

  // Aguarda o intervalo entre leituras
  if (
    millis() - TEMPO_ULTIMA_LEITURA <
    INTERVALO_LEITURA_MS
  ) {
    delay(1); // Evita problemas com watchdog
    return;
  }

  TEMPO_ULTIMA_LEITURA = millis();

  // Faz a medição do reservatório
  float distancia = lerDistanciaFiltrada();
  float nivel = distanciaParaNivel(distancia);

  /* ===== TRATAMENTO DE FALHA ===== */

  // Falha na leitura: desliga tudo por segurança
  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");

    acionarBomba(false);
    apagarLeds();

    return;
  }

  /* ===== CONTROLE DA BOMBA ===== */

  // Controle com histerese
  if (
    !STATUS_BOMBA &&
    nivel < NIVEL_LIGA_BOMBA
  ) {
    acionarBomba(true);
  }
  else if (
    STATUS_BOMBA &&
    nivel > NIVEL_DESLIGA_BOMBA
  ) {
    acionarBomba(false);
  }

  /* ===== INDICAÇÃO DO NÍVEL ===== */

  atualizarLedsNivel(nivel);

  /* ===== MONITOR SERIAL ===== */

  Serial.print("Distancia: ");
  Serial.print(distancia, 1);

  Serial.print(" cm | Nivel: ");
  Serial.print(nivel, 1);

  Serial.print(" % | Bomba: ");
  Serial.println(
    STATUS_BOMBA ? "LIGADA" : "DESLIGADA"
  );
}
