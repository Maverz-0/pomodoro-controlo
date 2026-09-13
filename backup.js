/* Copia de seguridad cifrada del histórico de foco.

   El servidor no puede leer nada: la clave de recuperación no sale nunca del
   móvil. Lo que viaja es el identificador del documento —SHA-256 de la clave—
   y un blob cifrado con AES-GCM, con la clave AES derivada de la misma clave
   de recuperación por PBKDF2.

   Consecuencia inevitable: si pierdes la clave, no hay forma de recuperar el
   histórico. Ni tú ni nadie. */

window.Backup = (() => {
  const KEY_LOCAL = 'pomodoro.backup.v1';   // { code, lastSync }
  const PBKDF2_ITER = 210000;
  const MAX_BLOB = 120 * 1024;              // margen bajo el límite del almacén

  // Alfabeto sin caracteres que se confundan al copiarlos a mano (0/O, 1/I/L).
  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CODE_LEN = 20;                      // ~98 bits de entropía

  const te = (s) => new TextEncoder().encode(s);
  const td = (b) => new TextDecoder().decode(b);

  const base = () => ((window.CONFIG && window.CONFIG.WORKER_URL) || '').replace(/\/$/, '');
  const configurado = () => !!base() && !base().includes('TU-SUBDOMINIO');

  /* ---------- clave de recuperación ---------- */

  function generarCodigo() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  /* Se muestra en grupos de cuatro para poder copiarla sin errores. */
  const formatear = (c) => (c.match(/.{1,4}/g) || []).join('-');
  const normalizar = (c) => (c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

  function valido(code) {
    const c = normalizar(code);
    return c.length === CODE_LEN && [...c].every((ch) => ALPHABET.includes(ch));
  }

  async function hex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* Identificador del documento. El servidor solo ve esto, nunca la clave. */
  async function docId(code) {
    return hex(await crypto.subtle.digest('SHA-256', te('pomodoro-id:' + normalizar(code))));
  }

  async function claveAES(code, salt) {
    const material = await crypto.subtle.importKey(
      'raw', te(normalizar(code)), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* ---------- codificación compacta ---------- */

  /* Los tramos van como [inicioEnSegundos, duracionEnSegundos] con el inicio
     en diferencias respecto al anterior. Un objeto {s,e} en milisegundos ocupa
     unos 40 bytes; así bajan a unos 10, que es lo que permite que 400 días de
     histórico quepan de sobra en un solo documento. */
  function empaquetar(segments) {
    const orden = [...segments].sort((a, b) => a.s - b.s);
    let prev = 0;
    const filas = orden.map((seg) => {
      const ini = Math.round(seg.s / 1000);
      const fila = [ini - prev, Math.max(1, Math.round((seg.e - seg.s) / 1000))];
      prev = ini;
      return fila;
    });
    return { v: 1, seg: filas };
  }

  function desempaquetar(obj) {
    if (!obj || obj.v !== 1 || !Array.isArray(obj.seg)) throw new Error('Formato desconocido');
    let prev = 0;
    return obj.seg.map(([delta, dur]) => {
      const ini = prev + delta;
      prev = ini;
      return { s: ini * 1000, e: (ini + dur) * 1000 };
    });
  }

  /* ---------- cifrado ---------- */

  async function cifrar(code, objeto) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await claveAES(code, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, te(JSON.stringify(objeto))
    ));
    const out = new Uint8Array(salt.length + iv.length + ct.length);
    out.set(salt, 0);
    out.set(iv, salt.length);
    out.set(ct, salt.length + iv.length);
    return btoa(String.fromCharCode(...out));
  }

  async function descifrar(code, b64) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const salt = raw.slice(0, 16);
    const iv = raw.slice(16, 28);
    const ct = raw.slice(28);
    const key = await claveAES(code, salt);
    // Si la clave no es la correcta, AES-GCM falla aquí al no cuadrar la etiqueta.
    const plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(td(plano));
  }

  /* ---------- estado local ---------- */

  function leerLocal() {
    try { return JSON.parse(localStorage.getItem(KEY_LOCAL)) || null; } catch { return null; }
  }
  function guardarLocal(v) {
    try { localStorage.setItem(KEY_LOCAL, JSON.stringify(v)); } catch {}
  }

  const codigo = () => (leerLocal() || {}).code || null;
  const activo = () => !!codigo();
  const ultimaSync = () => (leerLocal() || {}).lastSync || null;

  function activar() {
    if (codigo()) return codigo();
    const c = generarCodigo();
    guardarLocal({ code: c, lastSync: null });
    return c;
  }

  function desactivar() {
    try { localStorage.removeItem(KEY_LOCAL); } catch {}
  }

  /* ---------- red ---------- */

  async function subir() {
    const code = codigo();
    if (!code || !configurado()) return { ok: false, motivo: 'sin-configurar' };

    const paquete = empaquetar(Stats._raw().segments);
    const blob = await cifrar(code, paquete);
    if (blob.length > MAX_BLOB) return { ok: false, motivo: 'demasiado-grande' };

    const res = await fetch(base() + '/backup/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: await docId(code), blob }),
    });
    if (!res.ok) return { ok: false, motivo: 'servidor' };

    guardarLocal({ code, lastSync: Date.now() });
    return { ok: true, tramos: paquete.seg.length };
  }

  /* Descarga y reemplaza el histórico local. Devuelve cuántos tramos entraron. */
  async function restaurar(codeEntrada) {
    const code = normalizar(codeEntrada);
    if (!valido(code)) throw new Error('La clave no tiene el formato correcto.');
    if (!configurado()) throw new Error('El servidor de copias no está configurado.');

    const res = await fetch(base() + '/backup/get?id=' + (await docId(code)));
    if (res.status === 404) throw new Error('No hay ninguna copia con esa clave.');
    if (!res.ok) throw new Error('El servidor no responde.');

    const { blob } = await res.json();
    let paquete;
    try {
      paquete = await descifrar(code, blob);
    } catch {
      throw new Error('La clave no descifra esta copia.');
    }

    const segments = desempaquetar(paquete);
    Stats.replaceAll(segments);
    guardarLocal({ code, lastSync: Date.now() });
    return segments.length;
  }

  /* Sube con retardo: al cerrar varios tramos seguidos, una sola subida. */
  let pendiente = null;
  function sincronizar() {
    if (!activo() || !configurado()) return;
    clearTimeout(pendiente);
    pendiente = setTimeout(() => { subir().catch(() => {}); }, 4000);
  }

  return {
    activar, desactivar, activo, codigo, ultimaSync,
    subir, restaurar, sincronizar,
    formatear, normalizar, valido,
    // expuesto para las pruebas
    _empaquetar: empaquetar,
    _desempaquetar: desempaquetar,
    _cifrar: cifrar,
    _descifrar: descifrar,
    _docId: docId,
    _generarCodigo: generarCodigo,
  };
})();
