import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, applyMigrations } from '../../dev/d1-shim.mjs';
import worker from '../src/index.js';
import { createToken, createUser, countUsers } from '../src/auth.js';

const migrations = path.resolve(fileURLToPath(import.meta.url), '../../migrations');
const photoMigrations = path.resolve(fileURLToPath(import.meta.url), '../../migrations-photos');

export async function makeEnv(overrides = {}) {
  const DB = createD1(':memory:');
  await applyMigrations(DB, migrations);
  const PHOTOS = createD1(':memory:');
  await applyMigrations(PHOTOS, photoMigrations);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { d, x, y } = privateKey.export({ format: 'jwk' });
  return {
    DB,
    PHOTOS,
    SETUP_CODE: 'setup-code',
    PASSWORD_PEPPER: 'test-pepper',
    SESSION_SECRET: 'test-session-secret',
    VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', d, x, y }),
    VAPID_SUBJECT: 'https://example.github.io/tutor-planner/',
    ALLOWED_ORIGINS: 'https://example.github.io,http://localhost:8080',
    ...overrides,
  };
}

// Calls the worker like a browser would. Returns { status, body, headers }.
export function client(env) {
  let token = null;
  const call = async (method, url, body, headers = {}) => {
    const res = await worker.fetch(
      new Request(`https://api.test${url}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return {
    call,
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b ?? {}, h),
    patch: (u, b) => call('PATCH', u, b),
    put: (u, b) => call('PUT', u, b),
    del: (u) => call('DELETE', u),
    // Logs in as an account (created if needed). The first account becomes the owner through setup.
    async login(username = 'owner', password = 'correct horse') {
      if ((await countUsers(env)) === 0) {
        token = (await call('POST', '/api/setup', { code: env.SETUP_CODE, name: 'Owner', username, password })).body.token;
        return token;
      }
      const user =
        (await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first()) ??
        (await createUser(env, { name: username, username, password }));
      token = await createToken(env, user);
      return token;
    },
    setToken(value) {
      token = value;
    },
    logout() {
      token = null;
    },
  };
}

// A fake browser push subscription with real keys, so payloads can be decrypted in tests.
export function fakeSubscription(host = 'web.push.apple.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    json: {
      endpoint: `https://${host}/${crypto.randomBytes(8).toString('hex')}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
}

// Replaces global fetch so pushes are captured instead of sent.
export function capturePushes(status = 201) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: typeof status === 'function' ? status(url) : status });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}
