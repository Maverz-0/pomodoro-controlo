/* Suscripción a Web Push y comunicación con el Worker que dispara los avisos.

   En iOS esto solo funciona con la app instalada en la pantalla de inicio:
   en una pestaña normal de Safari `PushManager` no existe. */

window.Push = (() => {
  const base = () => (window.CONFIG && window.CONFIG.WORKER_URL || '').replace(/\/$/, '');

  const supported = () =>
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const installed = () =>
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  function b64urlToUint8(b64) {
    const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4))
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  const serialize = (sub) => {
    const raw = sub.toJSON();
    return { endpoint: raw.endpoint, keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth } };
  };

  async function currentSubscription() {
    if (!supported()) return null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? serialize(sub) : null;
  }

  /* Debe llamarse desde un gesto del usuario: iOS ignora la petición si no. */
  async function enable() {
    if (!supported()) {
      throw new Error(installed()
        ? 'Este navegador no admite notificaciones push.'
        : 'Instala la app en la pantalla de inicio para activar los avisos.');
    }
    if (!base() || base().includes('TU-SUBDOMINIO')) {
      throw new Error('Falta configurar WORKER_URL en config.js.');
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado.');

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      const res = await fetch(`${base()}/vapid-public-key`);
      if (!res.ok) throw new Error('El servidor de avisos no responde.');
      const { key } = await res.json();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToUint8(key),
      });
    }
    return serialize(sub);
  }

  async function post(path, body) {
    if (!base() || base().includes('TU-SUBDOMINIO')) return null;
    try {
      const res = await fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,   // que salga aunque iOS congele la app justo después
      });
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  }

  /* Programa el aviso para el instante en que acaba el bloque. */
  async function schedule(endAt, mode) {
    const subscription = await currentSubscription();
    if (!subscription) return null;
    return post('/schedule', { subscription, endAt, mode });
  }

  async function cancel() {
    const subscription = await currentSubscription();
    if (!subscription) return null;
    return post('/cancel', { subscription });
  }

  const status = () => {
    if (!supported()) return installed() ? 'unsupported' : 'not-installed';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return 'default';
  };

  return { supported, installed, enable, schedule, cancel, currentSubscription, status };
})();
