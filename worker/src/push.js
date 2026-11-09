// Web Push without dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291/8188),
// built on the Web Crypto API that Cloudflare Workers provide.
import { HttpError, b64urlEncode, b64urlDecode, concat } from './util.js';

const enc = new TextEncoder();

// Push services we are willing to send to (so the server can't be used to call arbitrary URLs).
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

export function isPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

let vapidCache = null;

// VAPID_PRIVATE_JWK is a P-256 private key in JWK form; the public key is derived from its x/y.
export async function getVapid(env) {
  if (!env.VAPID_PRIVATE_JWK) return null;
  if (vapidCache?.source === env.VAPID_PRIVATE_JWK) return vapidCache;
  const { d, x, y } = JSON.parse(env.VAPID_PRIVATE_JWK);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x, y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const publicKey = b64urlEncode(concat(new Uint8Array([4]), b64urlDecode(x), b64urlDecode(y)));
  vapidCache = { source: env.VAPID_PRIVATE_JWK, privateKey, publicKey };
  return vapidCache;
}

export async function vapidAuthorization(vapid, endpoint, subject, now = Date.now()) {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${header}.${b64urlEncode(enc.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// Encrypts `plaintext` for one browser subscription (p256dh + auth from PushSubscription.toJSON()).
export async function encryptPayload(p256dh, authSecret, plaintext) {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = last (and only) record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));

  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function sendOne(env, vapid, sub, payload, { ttl, urgency }) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(vapid, sub.endpoint, env.VAPID_SUBJECT),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body: await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload)),
  });
  const error = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, error };
}

export async function countDevices(env, userId) {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').bind(userId).first('n')) ?? 0;
}

// Sends `payload` ({title, body, url, tag}) to the user's registered devices, or just one of them.
export async function sendToDevices(env, userId, payload, { endpoint, ttl = 3600, urgency = 'high' } = {}) {
  const vapid = await getVapid(env);
  if (!vapid || !env.VAPID_SUBJECT) {
    throw new HttpError(500, 'Notifications are not set up on the server (VAPID key or subject missing)', 'push_not_configured');
  }

  const query = endpoint
    ? env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(userId, endpoint)
    : env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').bind(userId);
  const { results: subs } = await query.all();

  const report = { sent: 0, failed: 0, errors: [] };
  for (const sub of subs) {
    let result;
    try {
      result = await sendOne(env, vapid, sub, payload, { ttl, urgency });
    } catch (err) {
      result = { ok: false, status: 0, gone: false, error: String(err?.message || err) };
    }
    if (result.ok) {
      report.sent++;
      await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?')
        .bind(Date.now(), sub.endpoint)
        .run();
      continue;
    }
    report.failed++;
    report.errors.push({ device: sub.label, status: result.status, error: result.error });
    console.error('push failed', sub.label, result.status, result.error);
    if (result.gone) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
    } else {
      await env.DB.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?')
        .bind(sub.endpoint)
        .run();
    }
  }
  return report;
}
