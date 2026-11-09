// Accounts, passwords, login tokens, first-time setup and joining by invitation.
import { HttpError, DAY, MINUTE, json, readJson, b64urlEncode, b64urlDecode } from './util.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const TOKEN_DAYS = 180;
const MAX_FAILED = 10;
const LOCKOUT_MS = 15 * MINUTE;
const INVITE_DAYS = 14;
// What the Cloudflare free plan's CPU budget allows per login. The pepper (a secret kept outside the
// database) is what protects passwords if a copy of the database ever leaked.
const PBKDF2_ITERATIONS = 10_000;

// ---------- passwords ----------

async function pepper(env, password) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PASSWORD_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(String(password ?? ''))));
}

async function pbkdf2(input, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(env, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(await pepper(env, password), salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

async function verifyPassword(env, password, stored) {
  const [scheme, iterations, salt, expected] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const hash = await pbkdf2(await pepper(env, password), b64urlDecode(salt), Number(iterations));
  const want = b64urlDecode(expected);
  let diff = hash.length ^ want.length;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ (want[i] ?? 0);
  return diff === 0;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'The password must be at least 8 characters', 'weak_password');
  }
  return password;
}

export function normalizeUsername(username) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw new HttpError(400, 'Usernames are 3–32 letters, numbers, dots, dashes or underscores', 'bad_username');
  }
  return name;
}

function checkName(name) {
  const value = String(name ?? '').trim();
  if (!value || value.length > 80) throw new HttpError(400, 'Please enter your name', 'bad_name');
  return value;
}

// Readable random strings without look-alike characters (no 0/O, 1/I/L).
function randomCode(length) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
export const newTemporaryPassword = () => `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`.toLowerCase();
export const normalizeInviteCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- login tokens ----------

function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Token = "<payload>.<signature>"; the payload names the user and their token_version, so raising the
// version (password reset, removal) logs them out everywhere. Rotating SESSION_SECRET logs out everyone.
export async function createToken(env, user, now = Date.now()) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ u: user.id, v: user.token_version, exp: now + TOKEN_DAYS * DAY })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

async function userFromToken(env, token, now = Date.now()) {
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), b64urlDecode(sig), enc.encode(payload)))) return null;
    const claims = JSON.parse(dec.decode(b64urlDecode(payload)));
    if (!claims?.u || !(claims.exp > now)) return null;
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(claims.u).first();
    return user && user.token_version === claims.v ? user : null;
  } catch {
    return null;
  }
}

export async function requireUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const user = await userFromToken(env, header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!user) throw new HttpError(401, 'Please log in', 'not_logged_in');
  return user;
}

export function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Only the owner can do this', 'admin_only');
}

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  is_admin: !!u.is_admin,
  must_change_password: !!u.must_change_password,
});

// ---------- throttling ----------

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

async function checkThrottle(env, ip, username, now) {
  const row = await env.DB.prepare('SELECT SUM(ip = ?) AS by_ip, SUM(username = ?) AS by_user FROM login_attempts WHERE at > ?')
    .bind(ip, username ?? '', now - LOCKOUT_MS)
    .first();
  if ((row?.by_ip ?? 0) >= MAX_FAILED || (row?.by_user ?? 0) >= MAX_FAILED) {
    throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.', 'too_many_attempts');
  }
}

const recordFailure = (env, ip, username, now) =>
  env.DB.prepare('INSERT INTO login_attempts (ip, username, at) VALUES (?, ?, ?)').bind(ip, username ?? null, now).run();

// ---------- accounts ----------

export const countUsers = async (env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n')) ?? 0;

export async function createUser(env, { name, username, password, isAdmin = false }) {
  const now = Date.now();
  const user = {
    id: crypto.randomUUID(),
    name: checkName(name),
    username: normalizeUsername(username),
    password_hash: await hashPassword(env, checkPassword(password)),
    is_admin: isAdmin ? 1 : 0,
    must_change_password: 0,
    token_version: 0,
    created_at: now,
    updated_at: now,
  };
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(user.username).first()) {
    throw new HttpError(409, 'That username is taken', 'username_taken');
  }
  const cols = Object.keys(user);
  await env.DB.prepare(`INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => user[c]))
    .run();
  return user;
}

function assertConfigured(env) {
  if (!env.SESSION_SECRET || !env.PASSWORD_PEPPER) {
    throw new HttpError(500, 'Server is missing SESSION_SECRET or PASSWORD_PEPPER', 'server_not_configured');
  }
}

export async function login(request, env) {
  assertConfigured(env);
  const { username, password } = await readJson(request);
  const name = String(username ?? '').trim().toLowerCase();
  const ip = clientIp(request);
  const now = Date.now();
  await checkThrottle(env, ip, name, now);
  const user = name ? await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(name).first() : null;
  // Hash even for unknown usernames, so the response time doesn't reveal which usernames exist.
  const ok = user ? await verifyPassword(env, password, user.password_hash) : (await hashPassword(env, 'x'), false);
  if (!ok) {
    await recordFailure(env, ip, name, now);
    throw new HttpError(401, 'Wrong username or password', 'wrong_login');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ? OR username = ?').bind(ip, name).run();
  return json({ token: await createToken(env, user) });
}

const OWNED_TABLES = ['students', 'lessons', 'grades', 'homework', 'events', 'push_subscriptions', 'user_settings'];

// The very first account (the owner) is created with the SETUP_CODE secret, so nobody else can claim it.
export async function setup(request, env) {
  assertConfigured(env);
  if (!env.SETUP_CODE) throw new HttpError(500, 'Server is missing SETUP_CODE', 'server_not_configured');
  const { code, name, username, password } = await readJson(request);
  if ((await countUsers(env)) > 0) throw new HttpError(403, 'The app is already set up', 'already_set_up');
  const ip = clientIp(request);
  const now = Date.now();
  await checkThrottle(env, ip, null, now);
  const given = enc.encode(String(code ?? ''));
  const wanted = enc.encode(env.SETUP_CODE);
  let diff = given.length ^ wanted.length;
  for (let i = 0; i < wanted.length; i++) diff |= wanted[i] ^ (given[i] ?? 0);
  if (diff !== 0) {
    await recordFailure(env, ip, null, now);
    throw new HttpError(401, 'Wrong setup code', 'wrong_setup_code');
  }
  const user = await createUser(env, { name, username, password, isAdmin: true });
  // Anything stored before accounts existed belongs to the owner.
  await env.DB.batch(OWNED_TABLES.map((t) => env.DB.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = ''`).bind(user.id)));
  return json({ token: await createToken(env, user) }, 201);
}

export async function createInvite(env, admin, note) {
  const code = randomCode(8);
  const now = Date.now();
  const text = String(note ?? '').trim().slice(0, 80) || null;
  await env.DB.prepare('INSERT INTO invites (code, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(code, text, admin.id, now, now + INVITE_DAYS * DAY)
    .run();
  return { code, note: text, created_at: now, expires_at: now + INVITE_DAYS * DAY };
}

// Joining with an invite code: the code is reserved first, so it can only ever create one account.
export async function join(request, env) {
  assertConfigured(env);
  const { code, name, username, password } = await readJson(request);
  const ip = clientIp(request);
  const now = Date.now();
  await checkThrottle(env, ip, null, now);
  const invite = normalizeInviteCode(code);
  const { meta } = await env.DB.prepare(
    "UPDATE invites SET used_by = 'pending', used_at = ? WHERE code = ? AND used_by IS NULL AND expires_at > ?",
  )
    .bind(now, invite, now)
    .run();
  if (!meta.changes) {
    await recordFailure(env, ip, null, now);
    throw new HttpError(400, 'This invite code is not valid or has already been used', 'invite_invalid');
  }
  let user;
  try {
    user = await createUser(env, { name, username, password });
  } catch (err) {
    await env.DB.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ?').bind(invite).run();
    throw err;
  }
  await env.DB.prepare('UPDATE invites SET used_by = ? WHERE code = ?').bind(user.id, invite).run();
  return json({ token: await createToken(env, user) }, 201);
}

// Changing your own password logs out your other devices; this one gets a fresh token.
export async function changePassword(request, env, user) {
  const { current, next } = await readJson(request);
  if (!(await verifyPassword(env, current, user.password_hash))) {
    throw new HttpError(400, 'The current password is not right', 'wrong_current_password');
  }
  const updated = { ...user, token_version: user.token_version + 1 };
  await env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(env, checkPassword(next)), updated.token_version, Date.now(), user.id)
    .run();
  return json({ token: await createToken(env, updated) });
}
