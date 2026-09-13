/* Service worker: cachea el shell para que la app abra sin conexión.
   Sube CACHE al cambiar ficheros para forzar actualización. */
const CACHE = 'pomodoro-controlo-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './push.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  // Navegaciones: red primero, cache como respaldo (para no servir HTML rancio).
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto: cache primero.
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok && new URL(request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }))
  );
});

/* ---------- Avisos ---------- */

/* iOS 18.4+ entiende Declarative Web Push y pinta la notificación sin pasar
   por aquí. Este manejador cubre al resto de navegadores, que reciben el
   mismo JSON en el evento push. */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}

  const n = data.notification || {};
  const title = n.title || 'Pomodoro Controlo';

  e.waitUntil(self.registration.showNotification(title, {
    body: n.body || '',
    tag: n.tag || 'pomodoro-fin',
    renotify: true,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: n.navigate || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
