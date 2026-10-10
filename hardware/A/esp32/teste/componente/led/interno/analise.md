# Teste: LED interno

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

## Objetivo de Estudo

Verificar o funcionamento do LED interno da plataforma do ESP32.

## Materiais

- ESP32.

## Critério

Acionamento do LED via código e seu brilho.

## Resultados

O LED está funcionando como o esperado.
