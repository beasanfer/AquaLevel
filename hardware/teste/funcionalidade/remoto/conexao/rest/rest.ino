/*
 * AquaLevel | Firmware ESP32
 *
 * Monitora o nível do reservatório e controla a bomba com segurança local.
 * Envia telemetria à API e recebe limites, modo e comandos manuais.
 *
 * Ambiente: selecione USAR_RENDER antes de gravar o firmware.
 *   false -> servidor na rede local (HTTP)
 *   true  -> Render (HTTPS, com validação de certificado)
 *
 * Wi-Fi e IP local abaixo são apenas valores de exemplo.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>
#include <time.h>
#include <algorithm>

// =============================================================================
// 1. CONFIGURAÇÕES
// =============================================================================

// 1.1. Pinos do sensor, relé e LEDs
#define PINO_TRIG 13
#define PINO_ECHO 35
#define PINO_RELE 19
#define LED_BOMBA 4

const int LEDS_NIVEL[3] = {18, 17, 16};

// 1.2. Wi-Fi e ambiente de comunicação
const char* WIFI_SSID = "WIFI";
const char* WIFI_SENHA = "KEY";

const bool USAR_RENDER = false;

// Use o IP do computador (não "localhost") e a porta correta, se necessária.
const char* URL_NIVEL_LOCAL = "http://IP/api/nivel";
const char* URL_NIVEL_RENDER = "https://aqualevel.onrender.com/api/nivel";
const char* URL_NIVEL = USAR_RENDER ? URL_NIVEL_RENDER : URL_NIVEL_LOCAL;

// 1.3. Reservatório e controle
const bool RELE_ATIVO_EM_LOW = true;  // Depende do módulo de relé.

const float ALTURA_RESERVATORIO_CM = 23.3f;  // Sensor até o fundo (vazio).
const float GAP_SENSOR_CM = 0.0f;           // Sensor até a água (cheio).
const float CAPACIDADE_LITROS = 2.0f;

// Também deve coincidir com LIMITE_SEGURANCA_MANUAL em server.js.
const float NIVEL_CORTE_SEGURANCA = 98.0f;

const int NUMERO_AMOSTRAS = 7;
const unsigned long INTERVALO_LEITURA_MS = 1000UL;

// =============================================================================
// 2. ESTADO EM EXECUÇÃO
// =============================================================================

bool bombaLigada = false;
String modoAtual = "automatico";
unsigned long tempoUltimaLeitura = 0;
float ultimoNivelValido = -1.0f;

// Limites iniciais, atualizados quando a API devolve configuração válida.
float nivelMinimo = 30.0f;
float nivelMaximo = 90.0f;
float limiteLedVermelho = 30.0f;
float limiteLedVerde = 90.0f;

// Evita repetir comandos, especialmente após falhas ou reconexões.
String ultimoComandoAplicadoId = "";
bool bloqueioManual = false;
String sessaoESP32 = "";

// Registra a geometria no primeiro POST válido e após perda de comunicação.
// O servidor confirma o recebimento antes de interromper o envio dos parâmetros.
bool parametrosReservatorioPendentes = true;

// Após falha do sensor, não retoma operação sem nova sincronização válida.
bool aguardandoSincronizacaoAposFalha = false;

enum EstadoNivel { BAIXO = 0, MEDIO = 1, CHEIO = 2 };

// Evita mensagens repetidas quando o estado de comunicação não mudou.
enum EstadoComunicacao {
  COMUNICACAO_INICIAL,
  WIFI_DESCONECTADO,
  SERVIDOR_SEM_RESPOSTA_VALIDA,
  AGUARDANDO_HORARIO_NTP,
  SERVIDOR_CONECTADO
};
EstadoComunicacao estadoComunicacao = COMUNICACAO_INICIAL;
bool servidorJaRespondeu = false;

// =============================================================================
// 3. CERTIFICADOS HTTPS
// =============================================================================

/* Raízes de confiança públicas para HTTPS (Let's Encrypt/GTS).
 * A validacao verifica tambem o hostname e a validade do certificado.
 * Atualize as raizes se o provedor mudar sua cadeia de certificacao.
 * Nao usar setInsecure(): o servidor controla um atuador fisico. */
static const char RAIZES_HTTPS[] PROGMEM = R"CERTIFICADOS(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw
CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg
R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00
MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT
ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW
+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9
ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI
zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW
tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1
/q4AaOeMSQ+2b1tbFfLn
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo
27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w
Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw
TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl
qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH
szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8
Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk
MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92
wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p
aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN
VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID
AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb
C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy
h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4
7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J
ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef
MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/
Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT
6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ
0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm
2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb
bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlrsWNBCUaqxElqjANBgkqhkiG9w0BAQwFADBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjIwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjIwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQDO3v2m++zsFDQ8BwZabFn3GTXd98GdVarTzTukk3LvCvpt
nfbwhYBboUhSnznFt+4orO/LdmgUud+tAWyZH8QiHZ/+cnfgLFuv5AS/T3KgGjSY
6Dlo7JUle3ah5mm5hRm9iYz+re026nO8/4Piy33B0s5Ks40FnotJk9/BW9BuXvAu
MC6C/Pq8tBcKSOWIm8Wba96wyrQD8Nr0kLhlZPdcTK3ofmZemde4wj7I0BOdre7k
RXuJVfeKH2JShBKzwkCX44ofR5GmdFrS+LFjKBC4swm4VndAoiaYecb+3yXuPuWg
f9RhD1FLPD+M2uFwdNjCaKH5wQzpoeJ/u1U8dgbuak7MkogwTZq9TwtImoS1mKPV
+3PBV2HdKFZ1E66HjucMUQkQdYhMvI35ezzUIkgfKtzra7tEscszcTJGr61K8Yzo
dDqs5xoic4DSMPclQsciOzsSrZYuxsN2B6ogtzVJV+mSSeh2FnIxZyuWfoqjx5RW
Ir9qS34BIbIjMt/kmkRtWVtd9QCgHJvGeJeNkP+byKq0rxFROV7Z+2et1VsRnTKa
G73VululycslaVNVJ1zgyjbLiGH7HrfQy+4W+9OmTN6SpdTi3/UGVN4unUu0kzCq
gc7dGtxRcw1PcOnlthYhGXmy5okLdWTK1au8CcEYof/UVKGFPP0UJAOyh9OktwID
AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQUu//KjiOfT5nK2+JopqUVJxce2Q4wDQYJKoZIhvcNAQEMBQADggIBAB/Kzt3H
vqGf2SdMC9wXmBFqiN495nFWcrKeGk6c1SuYJF2ba3uwM4IJvd8lRuqYnrYb/oM8
0mJhwQTtzuDFycgTE1XnqGOtjHsB/ncw4c5omwX4Eu55MaBBRTUoCnGkJE+M3DyC
B19m3H0Q/gxhswWV7uGugQ+o+MePTagjAiZrHYNSVc61LwDKgEDg4XSsYPWHgJ2u
NmSRXbBoGOqKYcl3qJfEycel/FVL8/B/uWU9J2jQzGv6U53hkRrJXRqWbTKH7QMg
yALOWr7Z6v2yTcQvG99fevX4i8buMTolUVVnjWQye+mew4K6Ki3pHrTgSAai/Gev
HyICc/sgCq+dVEuhzf9gR7A/Xe8bVr2XIZYtCtFenTgCR2y59PYjJbigapordwj6
xLEokCZYCDzifqrXPW+6MYgKBesntaFJ7qBFVHvmJ2WZICGoo7z7GJa7Um8M7YNR
TOlZ4iBgxcJlkoKM8xAfDoqXvneCbT+PHV28SSe9zE8P4c52hgQjxcCMElv924Sg
JPFI/2R80L5cFtHvma3AH/vLrrw4IgYmZNralw4/KBVEqE8AyvCazM90arQ+POuV
7LXTWtiBmelDGDfrs7vRWGJB82bSj6p4lVQgw1oudCvV0b4YacCs1aTPObpRhANl
6WLAYv7YTVWW4tAR+kg0Eeye7QUd5MjWHYbL
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPluILrIPglJ209ZjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjMwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AAQfTzOHMymKoYTey8chWEGJ6ladK0uFxh1MJ7x/JlFyb+Kf1qPKzEUURout736G
jOyxfi//qXGdGIRFBEFVbivqJn+7kAHjSxm65FSWRQmx1WyRRK2EE46ajA2ADDL2
4CejQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBTB8Sa6oC2uhYHP0/EqEr24Cmf9vDAKBggqhkjOPQQDAwNpADBmAjEA9uEglRR7
VKOQFhG/hMjqb2sXnh5GmCCbn9MN2azTL818+FsuVbu/3ZL3pAzcMeGiAjEA/Jdm
ZuVDFhOD3cffL74UOO0BzrEXGhF16b0DjyZ+hOXJYKaV11RZt+cRLInUue4X
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
)CERTIFICADOS";

// =============================================================================
// 4. CONEXÃO WI-FI
// =============================================================================

// Relata transições reais, sem confundir falha de Wi-Fi com falha da API.
void atualizarEstadoComunicacao(EstadoComunicacao novoEstado) {
  if (estadoComunicacao == novoEstado) return;

  estadoComunicacao = novoEstado;
  switch (novoEstado) {
    case WIFI_DESCONECTADO:
      Serial.println("Comunicacao: Wi-Fi desconectado.");
      break;
    case SERVIDOR_SEM_RESPOSTA_VALIDA:
      Serial.println("Comunicacao: Wi-Fi conectado, mas sem resposta valida do servidor.");
      break;
    case AGUARDANDO_HORARIO_NTP:
      Serial.println("Comunicacao: Wi-Fi conectado; aguardando horario NTP para HTTPS.");
      break;
    case SERVIDOR_CONECTADO:
      Serial.println(servidorJaRespondeu
                         ? "Comunicacao: conexao com o servidor restabelecida."
                         : "Comunicacao: conexao com o servidor estabelecida.");
      servidorJaRespondeu = true;
      break;
    case COMUNICACAO_INICIAL:
      break;
  }
}

void conectarWiFi() {
  Serial.printf("Conectando em %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi OK. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nFalha no WiFi. Seguirei em modo offline.");
    atualizarEstadoComunicacao(WIFI_DESCONECTADO);
  }
}

void garantirWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  atualizarEstadoComunicacao(WIFI_DESCONECTADO);

  // Aguarda pelo menos 5 s entre tentativas de reconexão.
  static unsigned long ultimaTentativa = 0;
  if (millis() - ultimaTentativa < 5000) return;
  ultimaTentativa = millis();
  Serial.println("WiFi: tentando reconectar...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
}

// =============================================================================
// 5. MEDIÇÃO ULTRASSÔNICA
// =============================================================================
// Um eco ausente após 30 ms é considerado falha de leitura.
float lerDistanciaCrua() {
  digitalWrite(PINO_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PINO_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PINO_TRIG, LOW);

  unsigned long duracao = pulseIn(PINO_ECHO, HIGH, 30000UL);
  if (duracao == 0) return -1.0;
  return (duracao * 0.0343) / 2.0;
}

// Coleta até NUMERO_AMOSTRAS medições válidas e ordena os valores.
// Retorna o elemento central; com quantidade par, usa a mediana superior.
float lerDistanciaFiltrada() {
  float leituras[NUMERO_AMOSTRAS];
  int validas = 0;

  for (int i = 0; i < NUMERO_AMOSTRAS; i++) {
    float d = lerDistanciaCrua();
    if (d > 0) leituras[validas++] = d;
    if (i < NUMERO_AMOSTRAS - 1) delay(60);
  }

  if (validas == 0) return -1.0;

  std::sort(leituras, leituras + validas);
  return leituras[validas / 2];
}

// Converte a distância em nível: fundo = 0%, superfície no GAP = 100%.
// Limita o resultado a 0–100% e preserva o valor de falha (-1).
float distanciaParaNivel(float distancia) {
  if (distancia < 0) return -1.0;

  float nivel = (ALTURA_RESERVATORIO_CM - distancia) /
                (ALTURA_RESERVATORIO_CM - GAP_SENSOR_CM) * 100.0;

  if (nivel < 0) nivel = 0;
  if (nivel > 100) nivel = 100;
  return nivel;
}

// =============================================================================
// 6. ATUADORES E SEGURANÇA LOCAL
// =============================================================================
// O acionamento do relé sempre passa pela verificação dos limites.
bool atingiuLimite(float nivel) {
  return nivel >= nivelMaximo || nivel >= NIVEL_CORTE_SEGURANCA;
}

void acionarBomba(bool ligar) {
  if (ligar && (ultimoNivelValido < 0.0f || atingiuLimite(ultimoNivelValido))) {
    Serial.println("Acionamento impedido pelos limites ou falta de leitura.");
    ligar = false;
  }
  bombaLigada = ligar;
  digitalWrite(PINO_RELE, ligar == RELE_ATIVO_EM_LOW ? LOW : HIGH);
  digitalWrite(LED_BOMBA, ligar ? HIGH : LOW);
}

void apagarLeds() {
  for (int i = 0; i < 3; i++) digitalWrite(LEDS_NIVEL[i], LOW);
  digitalWrite(LED_BOMBA, LOW);
}

// Sinaliza baixo (< mínimo), médio (mínimo até antes do máximo) ou cheio.
void atualizarLedsNivel(float nivel) {
  EstadoNivel estado;
  if (nivel < limiteLedVermelho) {
    estado = BAIXO;
  } else if (nivel < limiteLedVerde) {
    estado = MEDIO;
  } else {
    estado = CHEIO;
  }

  for (int i = 0; i < 3; i++)
    digitalWrite(LEDS_NIVEL[i], i == estado ? HIGH : LOW);
}

// =============================================================================
// 7. COMUNICAÇÃO COM A API
// =============================================================================

// Um comando manual só pode ser aplicado uma vez e respeita os limites locais.
void processarComandoManual(JsonVariantConst comando, float nivel) {
  if (nivel < 0.0f || modoAtual != "manual" || comando.isNull() ||
      !comando["id"].is<const char*>() || !comando["ligar"].is<bool>()) {
    return;
  }

  const String id = comando["id"].as<String>();
  if (id.length() == 0 || id == ultimoComandoAplicadoId) return;

  const bool ligar = comando["ligar"].as<bool>();
  acionarBomba(ligar);

  // Registra o processamento mesmo se a segurança recusou o acionamento.
  ultimoComandoAplicadoId = id;
  if (bombaLigada == ligar) bloqueioManual = false;

  Serial.printf("Comando manual %s: bomba %s\n",
                id.c_str(), bombaLigada ? "LIGADA" : "DESLIGADA");
}

// Interpreta configuração e comandos recebidos após um POST bem-sucedido.
bool processarRespostaServidor(const String& resposta, float nivel) {
  JsonDocument doc;  // ArduinoJson 7.x
  const DeserializationError erro = deserializeJson(doc, resposta);

  if (erro) {
    Serial.printf("JSON inválido: %s\n", erro.c_str());
    return false;
  }

  // Durante uma falha do sensor, o servidor ainda pode atualizar os limites
  // e o modo, mas o relé deve permanecer desligado.
  const bool respostaDeFalha =
      nivel < 0.0f && doc["sensorOK"].is<bool>() &&
      doc["sensorOK"].as<bool>() == false;

  if (doc["sucesso"].as<bool>() != true && !respostaDeFalha) return false;

  const String novoModo = doc["modo"] | modoAtual;
  const float novoMin = doc["minimo"] | nivelMinimo;
  const float novoMax = doc["maximo"] | nivelMaximo;

  const bool modoValido = novoModo == "manual" || novoModo == "automatico";
  const bool limitesValidos =
      novoMin >= 1.0f && novoMin < novoMax &&
      novoMax <= NIVEL_CORTE_SEGURANCA - 1.0f;

  if (!modoValido || !limitesValidos) {
    Serial.println("Resposta contem modo ou limites invalidos.");
    return false;
  }

  // A entrada em modo manual nunca herda a bomba ligada pelo automático.
  if (modoAtual != "manual" && novoModo == "manual") {
    acionarBomba(false);
  }

  modoAtual = novoModo;
  nivelMinimo = novoMin;
  nivelMaximo = novoMax;
  limiteLedVermelho = novoMin;
  limiteLedVerde = novoMax;

  // Reenvia a geometria somente quando o servidor precisar dela.
  if (doc["parametrosRecebidos"].as<bool>() == true) {
    parametrosReservatorioPendentes = false;
  } else if (doc["solicitarParametros"].as<bool>() == true) {
    parametrosReservatorioPendentes = true;
  }

  // Se o limite foi reduzido, aplica o corte imediatamente.
  if (bombaLigada && atingiuLimite(nivel)) {
    acionarBomba(false);
  }

  // "bombaLigada" é telemetria, não uma ordem de acionamento.
  JsonVariantConst comando = doc["comandoManual"];
  processarComandoManual(comando, nivel);
  return true;
}

// Envia telemetria via POST e sincroniza modo, limites e comandos.
// Só retorna true para HTTP 200 acompanhado de configuração válida.
bool enviarDadosParaServidor(float nivel, float litros) {
  if (WiFi.status() != WL_CONNECTED) {
    atualizarEstadoComunicacao(WIFI_DESCONECTADO);
    parametrosReservatorioPendentes = true;
    return false;
  }

  // Sem NTP, não é possível validar HTTPS: não é falha confirmada do servidor.
  if (USAR_RENDER && time(nullptr) < 1704067200) {  // 01/01/2024 UTC
    atualizarEstadoComunicacao(AGUARDANDO_HORARIO_NTP);
    parametrosReservatorioPendentes = true;
    return false;
  }

  // Os clientes permanecem vivos até http.end(); somente um é utilizado.
  WiFiClient clienteLocal;
  WiFiClientSecure clienteSeguro;
  HTTPClient http;
  http.setTimeout(3000);

  bool iniciou = false;
  if (USAR_RENDER) {
    clienteSeguro.setCACert(RAIZES_HTTPS);
    iniciou = http.begin(clienteSeguro, URL_NIVEL);
  } else {
    iniciou = http.begin(clienteLocal, URL_NIVEL);
  }

  if (!iniciou) {
    Serial.println("HTTPClient: falha ao iniciar requisicao.");
    atualizarEstadoComunicacao(WiFi.status() == WL_CONNECTED
                                  ? SERVIDOR_SEM_RESPOSTA_VALIDA
                                  : WIFI_DESCONECTADO);
    parametrosReservatorioPendentes = true;
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  // Reporta o estado físico atual e o último comando processado.
  JsonDocument payloadDoc;  // ArduinoJson 7.x
  payloadDoc["nivel"] = nivel;
  payloadDoc["litros"] = litros;
  payloadDoc["bombaLigada"] = bombaLigada;
  payloadDoc["modoESP32"] = modoAtual;
  payloadDoc["sessaoESP32"] = sessaoESP32;
  payloadDoc["comandoAplicadoId"] = ultimoComandoAplicadoId;
  payloadDoc["bloqueioManual"] = bloqueioManual;
  // Fonte dos limites iniciais quando o servidor ainda nao possui configuracao.
  payloadDoc["minimoInicial"] = nivelMinimo;
  payloadDoc["maximoInicial"] = nivelMaximo;

  // Envia uma vez por conexão bem-sucedida, não a cada leitura de nível.
  if (parametrosReservatorioPendentes) {
    payloadDoc["alturaCm"] = ALTURA_RESERVATORIO_CM;
    payloadDoc["gapSensorCm"] = GAP_SENSOR_CM;
    payloadDoc["capacidadeLitros"] = CAPACIDADE_LITROS;
  }

  String payload;
  serializeJson(payloadDoc, payload);

  const int codigoHttp = http.POST(payload);
  bool sucesso = false;

  if (codigoHttp == HTTP_CODE_OK) {
    sucesso = processarRespostaServidor(http.getString(), nivel);
  } else {
    Serial.printf("POST falhou. Código: %d\n", codigoHttp);
  }

  // Se a API não respondeu validamente, registra novamente na recuperação.
  if (!sucesso) parametrosReservatorioPendentes = true;

  http.end();
  atualizarEstadoComunicacao(
      WiFi.status() != WL_CONNECTED
          ? WIFI_DESCONECTADO
          : sucesso ? SERVIDOR_CONECTADO : SERVIDOR_SEM_RESPOSTA_VALIDA);
  return sucesso;
}

// =============================================================================
// 8. INICIALIZAÇÃO
// =============================================================================
void setup() {
  // Primeira operacao do firmware: manter o rele desligado.
  // O estado antes do setup ainda depende do circuito do modulo.
  digitalWrite(PINO_RELE, RELE_ATIVO_EM_LOW ? HIGH : LOW);
  pinMode(PINO_RELE, OUTPUT);
  Serial.begin(115200);
  delay(500);
  pinMode(PINO_TRIG, OUTPUT);
  pinMode(PINO_ECHO, INPUT);
  for (int i = 0; i < 3; i++) pinMode(LEDS_NIVEL[i], OUTPUT);
  pinMode(LED_BOMBA, OUTPUT);

  digitalWrite(PINO_TRIG, LOW);
  acionarBomba(false);
  apagarLeds();

  // 64 bits aleatorios por boot para invalidar comandos de outra sessao.
  sessaoESP32 = String(esp_random(), HEX) + "-" + String(esp_random(), HEX);
  conectarWiFi();
  if (USAR_RENDER) {
    // O SNTP atualiza o relogio quando houver acesso a internet.
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  }

  Serial.printf("Servidor selecionado: %s\n", URL_NIVEL);
  Serial.println("Controlador iniciado.");
}

// =============================================================================
// 9. CICLO PRINCIPAL
// =============================================================================
// Mede, aplica segurança local, sincroniza e atualiza indicadores.
void loop() {
  garantirWiFi();

  // Uma queda real do WiFi tambem invalida a operacao manual.
  // Essa trava sera enviada na primeira telemetria apos a reconexao.
  if (modoAtual == "manual" && WiFi.status() != WL_CONNECTED) {
    bloqueioManual = true;
    if (bombaLigada) acionarBomba(false);
  }

  // Garante um intervalo mínimo entre os inícios das leituras.
  if (millis() - tempoUltimaLeitura < INTERVALO_LEITURA_MS) {
    delay(1);
    return;
  }
  tempoUltimaLeitura = millis();

  const float distancia = lerDistanciaFiltrada();
  const float nivel = distanciaParaNivel(distancia);

  // Sem eco válido: desliga bomba e LEDs e informa a falha se houver rede.
  if (distancia < 0) {
    Serial.println("Falha na leitura do HC-SR04.");
    ultimoNivelValido = -1.0f;
    if (modoAtual == "manual") bloqueioManual = true;
    acionarBomba(false);
    apagarLeds();
    aguardandoSincronizacaoAposFalha = true;
    enviarDadosParaServidor(-1.0f, 0.0f);
    return;
  }
  ultimoNivelValido = nivel;
  const float litros = nivel * CAPACIDADE_LITROS / 100.0f;

  // Não energiza a bomba no primeiro ciclo recuperado até confirmar
  // modo e limites com o servidor. Uma resposta de falha já processada
  // não basta: o modo pode ter mudado depois daquela resposta.
  bool sincronizouNestaLeitura = false;
  if (aguardandoSincronizacaoAposFalha) {
    if (!enviarDadosParaServidor(nivel, litros)) {
      acionarBomba(false);
      if (modoAtual == "manual") bloqueioManual = true;
      atualizarLedsNivel(nivel);
      Serial.println("Sensor recuperado; aguardando sincronizacao antes de ligar.");
      return;
    }
    aguardandoSincronizacaoAposFalha = false;
    sincronizouNestaLeitura = true;
  }

  // 1. Automático: liga abaixo do mínimo e desliga ao atingir o máximo.
  // O estado é atualizado antes do POST para refletir o relé no envio.
  if (modoAtual == "automatico") {
    if (!bombaLigada && nivel < nivelMinimo) {
      acionarBomba(true);
    } else if (bombaLigada && nivel >= nivelMaximo) {
      acionarBomba(false);
    }
  }

  // 2. O modo manual também respeita o máximo configurado (até 97%).
  if (bombaLigada && atingiuLimite(nivel)) {
    Serial.printf("Corte local: nivel %.1f%%, maximo %.1f%%.\n",
                  nivel, nivelMaximo);
    acionarBomba(false);
  }

  // 3. Evita um segundo POST se a recuperação já sincronizou nesta leitura.
  // O estado do relé após o controle local será confirmado no próximo ciclo.
  const bool comunicacaoServidorOK =
      sincronizouNestaLeitura || enviarDadosParaServidor(nivel, litros);

  // Um POST falho exige um novo comando identificado após a recuperação.
  if (!comunicacaoServidorOK && modoAtual == "manual") {
    if (!bloqueioManual)
      Serial.println("Falha de comunicacao: travando comandos manuais antigos.");
    bloqueioManual = true;
    if (bombaLigada) acionarBomba(false);
  }

  // 4. Defesa adicional após a atualização remota dos limites.
  if (bombaLigada && atingiuLimite(nivel)) {
    acionarBomba(false);
  }

  // 5. Atualiza os indicadores de nível.
  atualizarLedsNivel(nivel);

  // 6. Registra medição e estado atual no monitor serial.
  Serial.printf("Dist: %.1f cm | Nivel: %.1f%% | Bomba: %s | Modo: %s\n",
                distancia, nivel, bombaLigada ? "LIGADA" : "DESLIGADA",
                modoAtual.c_str());
}
