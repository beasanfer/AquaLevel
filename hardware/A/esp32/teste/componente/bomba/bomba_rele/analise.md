# Teste: Bomba + Relé

## Código

``` c++
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
```

## Objetivo do Estudo

Funcionamento do módulo relé com a bomba.

## Material(is)

Foi testado:

- Módule relé 5 V DC de 2 canais;
- Bomba;
- ESP 32.

---

## Resultado(s)

### Resultado 1

O relé não conseguiu ser acionado.

### Possíveis Soluções

Não foi conclusivo a procura do defeito: provavelmente trata-se da bobina do relé.

A solução mais óbvia é trocar de relé.

### Resultado 2

Com a troca do relé, o sistema funcionou perfeitamente.
