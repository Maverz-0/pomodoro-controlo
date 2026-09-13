/* Backend de avisos para Pomodoro Controlo.

   iOS no deja programar una notificación local a futuro ni ejecutar código
   en segundo plano, así que el disparo lo hace este Worker: la app le dice
   "avísame en el instante X" y una Durable Object Alarm despierta a esa hora
   y manda el Web Push. */

import { encryptPayload, vapidAuth } from './crypto.js';

const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // tope de sensatez: 6 h
const MAX_BLOB = 160 * 1024;             // tope del blob de copia

const LABELS = {
  focus: { title: 'Pomodoro terminado', body: 'Tómate un descanso.' },
  short: { title: 'Descanso terminado', body: 'De vuelta al foco.' },
  long:  { title: 'Descanso largo terminado', body: 'De vuelta al foco.' },
};

/* ---------- utilidades HTTP ---------- */

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok && origin ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const json = (data, init, extra) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function validSubscription(sub) {
  return sub && typeof sub.endpoint === 'string'
    && /^https:\/\//.test(sub.endpoint)
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}

/* ---------- Worker ---------- */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // La app pide la clave pública para suscribirse; así no se duplica en el cliente.
    if (url.pathname === '/vapid-public-key' && request.method === 'GET') {
      if (!env.VAPID_PUBLIC_KEY) return json({ error: 'VAPID sin configurar' }, { status: 500 }, cors);
      return json({ key: env.VAPID_PUBLIC_KEY }, {}, cors);
    }

    if ((url.pathname === '/schedule' || url.pathname === '/cancel') && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'JSON inválido' }, { status: 400 }, cors); }

      if (!validSubscription(body.subscription)) {
        return json({ error: 'Suscripción inválida' }, { status: 400 }, cors);
      }

      if (url.pathname === '/schedule') {
        const endAt = Number(body.endAt);
        if (!Number.isFinite(endAt)) {
          return json({ error: 'endAt inválido' }, { status: 400 }, cors);
        }
        const delay = endAt - Date.now();
        if (delay <= 0 || delay > MAX_DELAY_MS) {
          return json({ error: 'endAt fuera de rango' }, { status: 400 }, cors);
        }
      }

      // Una Durable Object por dispositivo, derivada del endpoint de la suscripción.
      const id = env.TIMER.idFromName(await sha256hex(body.subscription.endpoint));
      const stub = env.TIMER.get(id);
      const res = await stub.fetch(new Request(`https://do${url.pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---------- copia de seguridad cifrada ----------
       El servidor guarda un blob opaco bajo el hash de la clave de
       recuperación. No tiene la clave, así que no puede leer el contenido. */

    if (url.pathname === '/backup/put' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'JSON inválido' }, { status: 400 }, cors); }

      if (!/^[0-9a-f]{64}$/.test(body.id || '')) {
        return json({ error: 'id inválido' }, { status: 400 }, cors);
      }
      if (typeof body.blob !== 'string' || !body.blob || body.blob.length > MAX_BLOB) {
        return json({ error: 'blob inválido' }, { status: 400 }, cors);
      }

      const stub = env.BACKUP.get(env.BACKUP.idFromName(body.id));
      const res = await stub.fetch(new Request('https://do/put', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blob: body.blob }),
      }));
      return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/backup/get' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return json({ error: 'id inválido' }, { status: 400 }, cors);
      }
      const stub = env.BACKUP.get(env.BACKUP.idFromName(id));
      const res = await stub.fetch(new Request('https://do/get'));
      return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/health') return json({ ok: true }, {}, cors);

    return json({ error: 'No encontrado' }, { status: 404 }, cors);
  },
};

/* ---------- Durable Object: una alarma por dispositivo ---------- */

export class TimerAlarm {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();

    if (path === '/cancel') {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return Response.json({ ok: true, cancelled: true });
    }

    // Sustituye cualquier alarma previa: un dispositivo solo tiene un timer activo.
    await this.state.storage.put('job', {
      subscription: body.subscription,
      mode: LABELS[body.mode] ? body.mode : 'focus',
    });
    await this.state.storage.setAlarm(Number(body.endAt));
    return Response.json({ ok: true, endAt: Number(body.endAt) });
  }

  async alarm() {
    const job = await this.state.storage.get('job');
    await this.state.storage.deleteAll();
    if (!job) return;

    const label = LABELS[job.mode] || LABELS.focus;
    const payload = {
      // Declarative Web Push: iOS 18.4+ muestra el aviso sin pasar por el
      // service worker. Los navegadores que no lo entienden reciben este
      // mismo JSON en el evento push y lo pintan ellos.
      web_push: 8030,
      notification: {
        title: label.title,
        body: label.body,
        navigate: this.env.APP_URL || '/',
        tag: 'pomodoro-fin',
      },
    };

    try {
      await this.send(job.subscription, payload);
    } catch (err) {
      console.error('Fallo al enviar push:', err.message);
    }
  }

  async send(subscription, payload) {
    const body = await encryptPayload(
      new TextEncoder().encode(JSON.stringify(payload)),
      subscription.keys.p256dh,
      subscription.keys.auth
    );

    const auth = await vapidAuth(subscription.endpoint, {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT,
    });

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '120',
        Urgency: 'high',
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
    }
  }
}

/* ---------- Durable Object: la copia cifrada de un histórico ---------- */

export class StatsBackup {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/put') {
      const { blob } = await request.json();
      await this.state.storage.put('blob', blob);
      await this.state.storage.put('at', Date.now());
      return Response.json({ ok: true, bytes: blob.length });
    }

    const blob = await this.state.storage.get('blob');
    if (!blob) return Response.json({ error: 'no encontrado' }, { status: 404 });
    return Response.json({ blob, at: await this.state.storage.get('at') });
  }
}
