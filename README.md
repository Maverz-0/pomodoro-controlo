# Pomodoro Controlo

Temporizador estilo pomodoro como **PWA**: se instala en el iPhone desde Safari
(Compartir → *Añadir a pantalla de inicio*) y se abre a pantalla completa, sin barra
de navegador.

## Stack

Sin build ni dependencias: HTML + CSS + JavaScript. Se sirve tal cual desde GitHub Pages.

```
index.html              estructura
styles.css              estilos (tema oscuro, safe-area de iOS)
app.js                  lógica del temporizador y navegación
stats.js                registro y agregación del tiempo de foco
charts.js               vista de estadísticas
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
- Estadísticas de tiempo de foco por hora del día, día de la semana y semana del mes
- Aviso dentro de la app cuando hay una versión nueva

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

## Estadísticas

Solo cuenta como foco el tiempo con el temporizador **corriendo en modo foco**.
Se abre un tramo al pulsar Empezar y se cierra al pausar, reiniciar, saltar,
cambiar de modo o completar el bloque; los descansos no suman nada.

Los tramos se guardan como pares de marcas de tiempo en `localStorage`, así que
cerrar la app no pierde lo acumulado. Si la app muere con un bloque corriendo,
al volver el tramo se cierra en el instante en que el bloque habría terminado,
nunca más allá.

Al agregar, los tramos se parten en las fronteras que toque: un foco de 14:50 a
15:20 suma 10 minutos a las 14 h y 20 a las 15 h, en vez de contarse entero en
una sola. Igual con los que cruzan la medianoche.

Tres lecturas, cada una navegable hacia atrás:

| Vista | Agrupa | Periodo |
|---|---|---|
| Hora | 24 barras, una por hora | un día concreto |
| Día | 7 barras, lunes a domingo | una semana concreta |
| Semana | una barra por semana | un mes concreto |

Tocar una barra muestra el dato exacto con su fecha completa. Las semanas se
cortan en lunes, así que la primera y la última de un mes pueden ser parciales;
el detalle recorta el rango al mes que se está viendo.

Retención: 400 días.

## Actualizaciones

El service worker **no** toma el relevo por su cuenta. Cuando detecta una
versión nueva se queda en espera y la app enseña una barra «Hay una versión
nueva»; al pulsar Actualizar se le manda `SKIP_WAITING`, toma el control y la
página se recarga. Así nunca se mezcla media versión vieja con media nueva.

Al publicar cambios hay que subir `CACHE` en `sw.js`, o los navegadores
seguirán sirviendo los ficheros viejos desde la caché.
