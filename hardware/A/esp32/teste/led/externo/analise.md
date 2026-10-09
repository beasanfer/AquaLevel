# Teste: LEDs externo

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

Testar o funcionamento dos LEDs externos usados no projeto (vermelho, amarelo, verde e azul)

## Materias

Foi testado:

- 3 LEDs vermelhos
- 2 LEDs amarelo
- 1 LED verde
- 1 LED azul
- 4 resistores de 200 ohms

## Critérios

- Luzes das LEDs funcionando e emitindo bastante luz.
- O posicionamento dos LEDs estão certos com a polarização
- Os resistores tem a resistividade certa para o bom funcionamento dos LEDs

## Resultados

Verificou-se que um dos LED vermelho queimou antes dos teste; os dois LEDs amarelos, apesaram de estarem com suas luzes fracas, os LEDs amarelos; a mesma situação o LED verde.

Os outros LEDs vermelho e azul funcionaram como esperado.

## Possíveis Soluções

- Trocar os resistores por resistores com menos resistividade para cores amarelo e verde
