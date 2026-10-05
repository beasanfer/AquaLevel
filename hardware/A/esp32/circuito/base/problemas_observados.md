---
title: "Problemas Observados"
---

# Função `millis()`

Não pode estorar o período de aproximadamente de 24,8 dias para que não ocorra overflow em casos de verificação de intervalos:

``` c++
if (millis() - tempo_anterior >= intervalo)
```

Pode-se solucionar por:

- `esp_timer_get_time`: Apesar de ser arbitrário e custoso
- `millis64`: biblioteca externa
- RTC Externo: dificulta a implementação
- Ou desligar propositalmente o sistema a cada ~24,8 dias
