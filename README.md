# Pomodoro Controlo

Temporizador estilo pomodoro como **PWA**: se instala en el iPhone desde Safari
(Compartir → *Añadir a pantalla de inicio*) y se abre a pantalla completa, sin barra
de navegador.

## Stack

Sin build ni dependencias: HTML + CSS + JavaScript. Se sirve tal cual desde GitHub Pages.

```
index.html              estructura
styles.css              estilos (tema oscuro, safe-area de iOS)
app.js                  lógica del temporizador
push.js                 suscripción a Web Push
config.js               URL del Worker
manifest.webmanifest    metadatos de instalación
sw.js                   service worker (offline + recepción de push)
icons/                  iconos de la app
worker/                 backend en Cloudflare que dispara los avisos
```

## Cómo llegan los avisos con la app cerrada

iOS no permite programar una notificación local a futuro (la Notification
Triggers API nunca llegó a WebKit) ni ejecutar nada en segundo plano: no hay
Background Sync, ni Periodic Sync, ni Background Fetch, y el service worker
muere en cuanto sales de la app. Así que el disparo lo hace un servidor.

Como el temporizador se basa en marcas de tiempo, en el momento en que pulsas
Empezar ya se conoce el instante exacto del final. No hay nada que mantener
corriendo, solo algo que avise a esa hora:

```
Empezar → la app manda {suscripción, endAt} al Worker
          ↓
   una Durable Object Alarm duerme hasta endAt
          ↓
   Web Push → iOS despierta el service worker → notificación + vibración
```

Pausar, reiniciar, saltar o cambiar de modo cancelan la alarma.

Requisitos en el iPhone: la app tiene que estar **instalada en la pantalla de
inicio**. En una pestaña normal de Safari no existe `PushManager` y no hay
avisos. Funciona en España: Apple revirtió en marzo de 2024 la retirada de las
web apps de pantalla de inicio en la UE.

## Desarrollo local

Hace falta un servidor HTTP (el service worker no funciona con `file://`):

```bash
python -m http.server 8000
# → http://localhost:8000
```

Para probar en el iPhone dentro de la misma red WiFi, abre `http://<ip-del-pc>:8000`.
Ojo: Safari solo instala la PWA y registra el service worker sobre **HTTPS** o
`localhost`, así que para la prueba real usa la URL de GitHub Pages.

## Despliegue

Cada push a `main` publica el sitio vía GitHub Actions.
Hay que activarlo una vez: **Settings → Pages → Source: GitHub Actions**.

## Estado actual

Base funcional:

- Tres modos: Foco (25 min), Descanso (5 min), Descanso largo (15 min)
- Ciclo automático, con descanso largo cada 4 pomodoros
- Contador de rondas y de pomodoros completados
- Empezar / pausar / reanudar / reiniciar / saltar
- El tiempo se calcula con marcas de tiempo, no contando ticks, así que sigue
  siendo exacto aunque iOS congele la pestaña en segundo plano
- El estado se guarda en `localStorage` y sobrevive al cierre de la app
- Aviso al terminar: pitido (WebAudio) y vibración donde esté disponible

- Avisos con la app cerrada o en segundo plano, vía Web Push

### Limitaciones conocidas

- **Nada de Dynamic Island ni contador en la pantalla de bloqueo.** Eso exige
  ActivityKit, un framework nativo de iOS que se pinta con SwiftUI y WidgetKit.
  WebKit no lo expone a JavaScript y no hay forma de conseguirlo desde una PWA.
- `navigator.vibrate` no existe en Safari. La vibración al terminar la produce
  la notificación del sistema, no la web.
- Si la app está en primer plano cuando acaba el bloque, verás la notificación
  además de oír el pitido local: la alarma del servidor se dispara igual.

## El backend de avisos (`worker/`)

Cloudflare Worker + Durable Object Alarms. El plan gratuito basta de sobra.

```bash
cd worker
npm install
npm test                        # valida el cifrado contra el vector del RFC 8291
node scripts/gen-vapid.mjs      # genera las claves VAPID en .dev.vars

npx wrangler login
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler deploy
```

Después, pon la URL que devuelve `deploy` en `config.js` y haz push.

El cifrado Web Push (aes128gcm, RFC 8291) y la firma VAPID (RFC 8292) están
implementados a mano sobre WebCrypto en `worker/src/crypto.js`, sin dependencias.
`npm test` los verifica contra el vector de prueba oficial del RFC.

### Endpoints

| Ruta | Qué hace |
|---|---|
| `GET /vapid-public-key` | Clave pública para que la app se suscriba |
| `POST /schedule` | Programa el aviso: `{subscription, endAt, mode}` |
| `POST /cancel` | Cancela la alarma pendiente del dispositivo |
| `GET /health` | Comprobación de vida |
