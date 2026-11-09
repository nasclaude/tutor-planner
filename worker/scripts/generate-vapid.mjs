// Prints a new VAPID key pair for push notifications.
//   node scripts/generate-vapid.mjs            -> human readable
//   node scripts/generate-vapid.mjs --jwk-only -> just the private JWK (pipe into `wrangler secret put`)
import { webcrypto } from 'node:crypto';

const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const { kty, crv, d, x, y } = await webcrypto.subtle.exportKey('jwk', privateKey);
const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', publicKey));
const jwk = JSON.stringify({ kty, crv, d, x, y });

if (process.argv.includes('--jwk-only')) {
  process.stdout.write(jwk);
} else {
  console.log('VAPID_PRIVATE_JWK (secret):');
  console.log(jwk);
  console.log('\nPublic key (shared with browsers automatically):');
  console.log(Buffer.from(raw).toString('base64url'));
}
