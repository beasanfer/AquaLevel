# Teste: Monitor Serial

## Código:

``` c++
void setup() {
  Serial.begin(9600);
}

void loop() {
  Serial.println("teste serial");
  delay(1000);
}
```

## Objetivo do Estudo

Provar que o ESP32 consegue acessar o monitor serial

## Critério

ESP32 conseguir imprimir o texto previamente escolhido no monitor serial 
