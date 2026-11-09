import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, getVapid, vapidAuthorization, isPushEndpoint } from '../src/push.js';
import { fakeSubscription } from './helpers.mjs';

test('payload encryption is readable by the reference aes128gcm implementation', async () => {
  const sub = fakeSubscription();
  const message = JSON.stringify({ title: 'Lesson in 3 hours · 13:00', body: 'Arthas — Math, 8th grade ✓' });
  const body = await encryptPayload(sub.json.keys.p256dh, sub.json.keys.auth, message);
  const decrypted = ece.decrypt(Buffer.from(body), {
    version: 'aes128gcm',
    privateKey: sub.ecdh,
    authSecret: sub.json.keys.auth,
  });
  assert.equal(decrypted.toString('utf8'), message);
});

test('VAPID header carries a valid ES256 signature and the right claims', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { d, x, y } = privateKey.export({ format: 'jwk' });
  const vapid = await getVapid({ VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', d, x, y }) });

  const header = await vapidAuthorization(vapid, 'https://web.push.apple.com/abc123', 'https://example.github.io/app/');
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, p, s] = jwt.split('.');

  const valid = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  assert.ok(valid, 'signature verifies');

  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://example.github.io/app/');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);

  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  assert.equal(k, rawPublic.toString('base64url'));
});

test('only real push services are accepted as endpoints', () => {
  assert.ok(isPushEndpoint('https://web.push.apple.com/QGx'));
  assert.ok(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(!isPushEndpoint('http://web.push.apple.com/x'));
  assert.ok(!isPushEndpoint('https://evil.example.com/push.apple.com'));
  assert.ok(!isPushEndpoint('https://notpush.apple.com.evil.com/'));
  assert.ok(!isPushEndpoint('not a url'));
});
