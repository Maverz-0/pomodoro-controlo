/* Verifica el cifrado aes128gcm contra el vector de prueba del RFC 8291 §5
   y la firma VAPID contra su propia clave pública. Se ejecuta con:
     node --test worker/test/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, vapidAuth, b64urlToBytes, bytesToB64url } from '../src/crypto.js';

const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  // RFC 8291 secc. 5: cabecera de 86 octetos + 59 de ciphertext AES-GCM.
  expected: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
          + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
          + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function keyPairFrom(privB64, pubB64) {
  const pub = b64urlToBytes(pubB64);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk', { ...jwk, d: privB64 }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const publicKey = await crypto.subtle.importKey(
    'raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );
  return { privateKey, publicKey };
}

test('encryptPayload reproduce el vector del RFC 8291', async () => {
  const body = await encryptPayload(
    new TextEncoder().encode(V.plaintext),
    V.uaPublic,
    V.authSecret,
    { salt: b64urlToBytes(V.salt), keyPair: await keyPairFrom(V.asPrivate, V.asPublic) }
  );
  assert.equal(bytesToB64url(body), V.expected);
});

test('encryptPayload usa salt y clave efimera nuevos en cada envio', async () => {
  const args = [new TextEncoder().encode('hola'), V.uaPublic, V.authSecret];
  const a = bytesToB64url(await encryptPayload(...args));
  const b = bytesToB64url(await encryptPayload(...args));
  assert.notEqual(a, b, 'dos cifrados identicos implicarian salt reutilizado');
});

test('vapidAuth emite un JWT ES256 verificable con la clave publica', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

  const header = await vapidAuth('https://web.push.apple.com/abc123', {
    publicKey: bytesToB64url(rawPub),
    privateKey: jwk.d,
    subject: 'mailto:test@example.com',
  });

  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, `formato de cabecera inesperado: ${header}`);

  const [jwt, k] = [m[1], m[2]];
  const [h, p, sig] = jwt.split('.');

  assert.equal(k, bytesToB64url(rawPub));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlToBytes(h))),
                   { typ: 'JWT', alg: 'ES256' });

  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  assert.equal(claims.aud, 'https://web.push.apple.com', 'aud debe ser solo el origen');
  assert.equal(claims.sub, 'mailto:test@example.com');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'exp debe estar en el futuro');
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, 'exp no puede pasar de 24 h');

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`)
  );
  assert.ok(valid, 'la firma no verifica');
});
