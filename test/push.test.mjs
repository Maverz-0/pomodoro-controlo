/* Prueba de la cola de programar/cancelar avisos.

   Lo que importa: encadenando bloques automáticamente, el cancelar del que
   acaba y el programar del que empieza salen casi a la vez. Si llegasen al
   revés, el cancelar borraría el aviso recién puesto y el bloque terminaría
   en silencio. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FUENTE = readFileSync(new URL('../push.js', import.meta.url), 'utf8');

function cargar({ suscrito = true, retardos = {} } = {}) {
  const llamadas = [];

  const sub = {
    toJSON: () => ({
      endpoint: 'https://web.push.apple.com/prueba',
      keys: { p256dh: 'PPP', auth: 'AAA' },
    }),
  };

  const win = {
    CONFIG: { WORKER_URL: 'https://ejemplo.workers.dev' },
    matchMedia: () => ({ matches: true }),
    Notification: { permission: 'granted', requestPermission: async () => 'granted' },
    // `supported()` comprueba que exista; con que esté declarado basta.
    PushManager: function PushManager() {},
  };

  const nav = {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => (suscrito ? sub : null) },
      }),
    },
  };

  // Indirección para poder sustituir el fetch después de cargar el módulo,
  // que captura la referencia al construirse.
  const holder = {
    fn: async (url) => {
      const ruta = new URL(url).pathname;
      llamadas.push(ruta + ':entrada');
      const espera = retardos[ruta] || 0;
      if (espera) await new Promise((r) => setTimeout(r, espera));
      llamadas.push(ruta + ':salida');
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  const fetchStub = (...a) => holder.fn(...a);

  // `window` es también el objeto global del módulo: ahí cuelga `window.Push`.
  new Function('window', 'navigator', 'fetch', 'Notification', 'AbortController', 'setTimeout', 'clearTimeout', FUENTE)(
    win, nav, fetchStub, win.Notification, AbortController, setTimeout, clearTimeout
  );

  const entradas = () => llamadas.filter((l) => l.endsWith(':entrada')).map((l) => l.split(':')[0]);
  return { Push: win.Push, llamadas, entradas, holder };
}

test('cancelar y programar llegan en el orden en que se pidieron', async () => {
  // El cancelar tarda más que el programar: sin cola, el programar adelantaría.
  const { Push, llamadas, entradas } = cargar({ retardos: { '/cancel': 60 } });

  const a = Push.cancel();
  const b = Push.schedule(Date.now() + 60000, 'focus');
  await Promise.all([a, b]);

  assert.deepEqual(entradas(), ['/cancel', '/schedule'], 'el orden de salida no se respetó');

  // Y no deben solaparse: el segundo entra después de que salga el primero.
  assert.deepEqual(llamadas, [
    '/cancel:entrada', '/cancel:salida',
    '/schedule:entrada', '/schedule:salida',
  ], 'las peticiones se solaparon en vez de ir en fila');
});

test('una ráfaga de cuatro llamadas mantiene el orden', async () => {
  const { Push, entradas } = cargar({ retardos: { '/cancel': 30 } });

  Push.cancel();
  Push.schedule(Date.now() + 1000, 'focus');
  Push.cancel();
  await Push.schedule(Date.now() + 2000, 'short');

  assert.deepEqual(entradas(), ['/cancel', '/schedule', '/cancel', '/schedule']);
});

test('un fallo de red no atasca la cola', async () => {
  const { Push, entradas, holder } = cargar();
  const bueno = holder.fn;
  let primera = true;
  holder.fn = async (...a) => {
    if (primera) { primera = false; throw new Error('red caída'); }
    return bueno(...a);
  };

  await Push.cancel();                                 // esta revienta por dentro
  await Push.schedule(Date.now() + 60000, 'focus');     // esta debe salir igual

  assert.ok(entradas().includes('/schedule'), 'la cola quedó bloqueada tras el fallo');
});

test('sin suscripción no se llama al servidor', async () => {
  const { Push, llamadas } = cargar({ suscrito: false });
  await Push.cancel();
  await Push.schedule(Date.now() + 60000, 'focus');
  assert.equal(llamadas.length, 0, 'no debe haber tráfico sin suscripción');
});
