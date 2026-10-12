#define PINO_RELE 19

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(PINO_RELE, OUTPUT);

  digitalWrite(PINO_RELE, LOW);

  Serial.println("ESP32 iniciado - Controle de Relé no pino 19");
}

void loop() {
  Serial.println("Relé LIGADO");
  digitalWrite(PINO_RELE, HIGH);
  delay(5000);  // 5 s

  // Desliga o relé
  Serial.println("Relé DESLIGADO");
  digitalWrite(PINO_RELE, LOW);
  delay(5000);  // 5 s
}
