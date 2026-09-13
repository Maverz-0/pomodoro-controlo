/* Genera un par de claves VAPID (P-256) y lo deja en worker/.dev.vars,
   que está en .gitignore. Uso: node worker/scripts/gen-vapid.mjs */

import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);

const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = jwk.d;

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`Ya existe ${out}. Usa --force para regenerar (invalidará las suscripciones actuales).`);
  process.exit(1);
}

writeFileSync(out,
  `VAPID_PUBLIC_KEY=${publicKey}\n` +
  `VAPID_PRIVATE_KEY=${privateKey}\n` +
  `VAPID_SUBJECT=mailto:maverze.0@gmail.com\n`
);

console.log('Claves VAPID generadas en worker/.dev.vars');
console.log('  pública :', publicKey);
console.log('  privada : (guardada en el fichero, no se muestra)');
