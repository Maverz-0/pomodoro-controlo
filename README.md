# Pomodoro

Temporizador estilo pomodoro como **PWA**: se instala en el iPhone desde Safari
(Compartir → *Añadir a pantalla de inicio*) y se abre a pantalla completa, sin barra
de navegador.

## Stack

Sin build ni dependencias: HTML + CSS + JavaScript. Se sirve tal cual desde GitHub Pages.

```
index.html              estructura
styles.css              estilos (tema oscuro, safe-area de iOS)
app.js                  lógica del temporizador
manifest.webmanifest    metadatos de instalación
sw.js                   service worker (funciona sin conexión)
icons/                  iconos de la app
```

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

### Limitaciones conocidas

- iOS no permite avisos con la app cerrada sin notificaciones push. Ahora mismo
  el pitido solo suena si la app está en primer plano.
