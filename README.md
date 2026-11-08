# Smart Finder

Aplicativo web para **descobrir dispositivos Bluetooth Low Energy (BLE) próximos**, com foco em
smartwatches, e usar a **intensidade do sinal (RSSI)** para ajudar você a se aproximar deles.

HTML + CSS + JavaScript puros (sem build, sem dependências). Tudo roda no navegador; nada é enviado
para a internet.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Estrutura da página |
| `style.css` | Tema escuro, azul neon, radar animado, layout responsivo |
| `signal.js` | Lógica pura de sinal (classificação, suavização, tendência) — testável no Node |
| `app.js` | Web Bluetooth, busca, radar, lista, painel de localização, histórico, erros |
| `signal.test.js` | Testes da lógica de sinal |

## Como executar

Web Bluetooth **exige HTTPS** (ou `localhost`).

**No computador (mais rápido):**

```bash
cd pasta-do-projeto
python3 -m http.server 8000
# abra http://localhost:8000 no Chrome ou Edge
```

`localhost` é tratado como seguro, então o Bluetooth funciona sem certificado.

**No celular Android:** o celular não consegue abrir o `localhost` do computador com HTTPS. Use uma destas opções:

1. **Publicar** o site (veja abaixo) e abrir o endereço HTTPS no Chrome do celular; ou
2. Rodar o servidor no PC e, no Chrome do PC, abrir `chrome://inspect/#devices` → *Port forwarding* (`8000` → `localhost:8000`) com o celular conectado por USB; aí o celular abre `http://localhost:8000` (também é contexto seguro).

## Como publicar (HTTPS automático e gratuito)

Basta enviar a pasta inteira (os arquivos ficam todos juntos, na raiz):

- **Netlify Drop** — arraste a pasta em <https://app.netlify.com/drop>. Em segundos você recebe um link HTTPS.
- **GitHub Pages** — crie um repositório, envie os arquivos, e em *Settings → Pages* escolha a branch `main` e a pasta `/ (root)`.
- **Vercel** ou **Cloudflare Pages** — importe o repositório; não precisa de comando de build nem de pasta de saída especial.

Não coloque o site dentro de um `<iframe>` de outro domínio: o navegador bloqueia Bluetooth nesse caso.

## Como o app encontra dispositivos (e por que há dois modos)

A Web Bluetooth foi desenhada por privacidade: um site **não pode** listar livremente tudo que está ao redor.
O Smart Finder usa o que o navegador realmente oferece:

1. **Modo varredura** (`navigator.bluetooth.requestLEScan`) — escuta anúncios BLE continuamente e mostra
   nome e RSSI de vários dispositivos em tempo real. É um recurso **experimental**: no Chrome/Edge ative
   `chrome://flags/#enable-experimental-web-platform-features` e reabra o navegador.
2. **Modo seletor** (`navigator.bluetooth.requestDevice`) — o navegador abre a janela nativa e você
   escolhe um dispositivo. Depois, se disponível, `watchAdvertisements()` entrega o RSSI em tempo real
   (também depende do recurso experimental). O botão "Escolher outro dispositivo" acrescenta mais um.

O app detecta sozinho qual modo existe e mostra o resultado no aviso do topo. **Nada é simulado**: o que o
navegador não informa aparece como "n/d" ou "não informado".

## Recursos

- Radar circular animado durante a busca; os anéis indicam proximidade **relativa** pelo sinal.
  O ângulo dos pontos é só decorativo (BLE não informa direção) e isso está escrito na tela.
- Lista de dispositivos com nome, identificador curto, RSSI, barras de sinal e marca "nome sugere relógio"
  (palpite pelo nome, não garantia). Filtro "Só com nome".
- Painel de localização: medidor, nível **fraco / médio / forte** (≥ −60 dBm forte, ≥ −80 médio),
  mensagem de tendência ("Sinal aumentando: você está chegando mais perto"), gráfico recente e
  bipe/vibração opcionais (mais rápido = sinal mais forte).
- Informações de conexão: estado do anúncio, GATT, permissão, TX Power, serviços e fabricante (quando
  anunciados) e teste de conexão GATT (lê bateria se o dispositivo expuser).
- Histórico da sessão (`sessionStorage`; some ao fechar a aba).
- Tratamento de erros: HTTPS ausente, navegador incompatível, Bluetooth desligado, permissão negada,
  seleção cancelada, falha de conexão, sem anúncios recentes.

## Limitações (mostradas também na própria página)

- **Só localiza o que está transmitindo.** Dispositivo desligado, sem bateria ou sem anunciar não pode ser encontrado.
- **RSSI não é distância.** Varia com corpo, paredes, antena e interferência. O app mostra tendência, nunca metros.
- **Sem MAC, sem GPS.** O navegador entrega um identificador local opaco por site.
- **Smartwatches são difíceis:** muitos param de anunciar quando conectados ao celular, usam endereço aleatório e escondem o nome. Tente desativar o Bluetooth do celular pareado ou colocar o relógio em modo de pareamento.
- **Compatibilidade:** Chrome, Edge, Opera e Samsung Internet (Android e computador).
  **Safari e Firefox não suportam Web Bluetooth. No iPhone/iPad, todo navegador usa o motor do Safari**,
  então o Chrome do iOS também não funciona; uma alternativa é um navegador com suporte, como o Bluefy.
- **Android:** permita "Dispositivos por perto" (Android 12+) ou ative a Localização do aparelho (Android 11 ou anterior).
- Não é o "Encontre meu dispositivo" do Google/Apple: não usa rede de crowdsourcing nem localiza aparelhos sem bateria.

## Testes

```bash
node signal.test.js
```

Cobrem conversão de RSSI, classificação forte/médio/fraco, suavização, tendência (subindo, caindo, estável,
com ruído e histerese), mensagens e utilidades. A integração com Web Bluetooth foi exercitada em Chrome
headless com um Bluetooth simulado **apenas no teste** (o app em si não simula nada).
