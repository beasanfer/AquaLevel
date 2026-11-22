
#define TRIG_PIN 13
#define ECHO_PIN 35

#define NUM_AMOSTRAS 7
#define INTERVALO 1000

unsigned long ultimoTempo = 0;

// Realiza uma medição de distância em centímetros
float medirDistancia() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duracao = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duracao == 0) {
    return -1;  // Leitura inválida
  }

  return (duracao * 0.0343) / 2.0;
}

// Calcula a mediana de 7 amostras
float calcularMediana() {
  float amostras[NUM_AMOSTRAS];
  int validas = 0;

  // Coleta 7 amostras válidas, no máximo 7 tentativas
  for (int i = 0; i < NUM_AMOSTRAS; i++) {
    float distancia = medirDistancia();

    if (distancia >= 0) {
      amostras[validas++] = distancia;
    }

    delay(60);
  }

  if (validas == 0) {
    return -1;
  }

  // Ordenação crescente
  for (int i = 0; i < validas - 1; i++) {
    for (int j = i + 1; j < validas; j++) {
      if (amostras[i] > amostras[j]) {
        float temp = amostras[i];
        amostras[i] = amostras[j];
        amostras[j] = temp;
      }
    }
  }

  // Retorna a mediana
  if (validas % 2 == 1) {
    return amostras[validas / 2];
  }

  return (amostras[validas / 2 - 1] +
          amostras[validas / 2]) / 2.0;
}

void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  digitalWrite(TRIG_PIN, LOW);
}

void loop() {
  if (millis() - ultimoTempo >= INTERVALO) {
    ultimoTempo = millis();

    float mediana = calcularMediana();

    if (mediana < 0) {
      Serial.println("Sem leituras validas");
    } else {
      Serial.print("Mediana: ");
      Serial.print(mediana, 2);
      Serial.println(" cm");
    }
  }
}
