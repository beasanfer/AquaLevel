# Teste: Sensor HC-SR 04

## Código

``` c++
#include <Arduino.h>

#define LED_VERMELHO 4
#define LED_AMARELO  16
#define LED_VERDE    17
#define LED_AZUL     18

void setup() {
  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(LED_AMARELO, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AZUL, OUTPUT);
}

void loop() {
  digitalWrite(LED_VERMELHO, HIGH);
  delay(2000);
  digitalWrite(LED_VERMELHO, LOW);

  digitalWrite(LED_AMARELO, HIGH);
  delay(2000);
  digitalWrite(LED_AMARELO, LOW);
  
  digitalWrite(LED_VERDE, HIGH);
  delay(2000);
  digitalWrite(LED_VERDE, LOW);

  digitalWrite(LED_AZUL, HIGH);
  delay(2000);
  digitalWrite(LED_AZUL, LOW);
}
```

## Objeto de Estudo

Verificar o funcionamento do sensor HC-SR 04.

## Materiais

- ESP32;
- HC-SR 04.

## Critério

- Acionamento do HC-SR 04;
- Impressão do resultado correto no monitor serial.

---

## Resultados

### Resultado 1

O resultado impresso no monitor serial estava corrompido

### Possíveis Soluções

Realizar teste para verificar como o Monitor Serial imprimirá um resultado simples.

### Resultado 2

Após análise do primeiro teste, percebeu-se que o erro estava na quantidade de bound.

Depois do resultado, o código funcionou perfeitamente.
