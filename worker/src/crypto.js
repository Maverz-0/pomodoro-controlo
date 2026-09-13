/* Cifrado Web Push (RFC 8291, aes128gcm) y firma VAPID (RFC 8292),
   implementados sobre WebCrypto para poder correr dentro de un Worker. */

const te = (s) => new TextEncoder().encode(s);

export function b64urlToBytes(s) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function bytesToB64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8
  );
  return new Uint8Array(bits);
}

/* Cifra el payload contra la clave pública del navegador suscrito.
   Devuelve el cuerpo completo aes128gcm: salt | rs | idlen | clave efímera | ciphertext

   `fixed` solo lo usan los tests, para reproducir el vector del RFC con un
   salt y una clave efímera conocidos en vez de aleatorios. */
export async function encryptPayload(plaintext, p256dhB64, authB64, fixed) {
  const uaPublic = b64urlToBytes(p256dhB64);  // 65 bytes, formato 0x04|x|y
  const authSecret = b64urlToBytes(authB64);  // 16 bytes

  // Par de claves efímero del servidor para este envío.
  const asPair = (fixed && fixed.keyPair) || await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asPair.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPair.privateKey, 256)
  );

  // PRK: mezcla el secreto ECDH con el auth secret y ambas claves públicas.
  const keyInfo = concat(te('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = (fixed && fixed.salt) || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(te('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(te('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marca que este es el último (y único) registro.
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);

  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/* WebCrypto no importa claves EC privadas en crudo, así que reconstruimos
   un JWK con la privada (d) y las coordenadas sacadas de la pública. */
async function importVapidKey(privateB64, publicB64) {
  const pub = b64urlToBytes(publicB64);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: privateB64,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/* Cabecera Authorization con el JWT que prueba que el envío es nuestro. */
export async function vapidAuth(endpoint, { publicKey, privateKey, subject }) {
  const header = bytesToB64url(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(te(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));

  const key = await importVapidKey(privateKey, publicKey);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, te(`${header}.${payload}`)
  );

  return `vapid t=${header}.${payload}.${bytesToB64url(sig)}, k=${publicKey}`;
}
