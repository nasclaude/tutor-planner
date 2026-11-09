import { HttpError, json, readJson } from './util.js';
import { login, setup, join, changePassword, requireUser, publicUser, countUsers } from './auth.js';
import { listPeople, addInvite, cancelInvite, resetPassword, removeUser } from './users.js';
import { listAll, createRow, createSeries, updateRow, deleteRow } from './crud.js';
import { getSettings, updateSettings } from './settings.js';
import { getVapid, isPushEndpoint, sendToDevices, countDevices } from './push.js';
import { runReminders, testMessage } from './reminders.js';

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

async function getData(env, user) {
  const [rows, settings, vapid, devices] = await Promise.all([
    listAll(env, user.id),
    getSettings(env, user.id),
    getVapid(env),
    countDevices(env, user.id),
  ]);
  return { ...rows, settings, me: publicUser(user), vapidPublicKey: vapid?.publicKey ?? null, devices, serverTime: Date.now() };
}

// A phone or browser registers for notifications. If it was registered by someone else before
// (a shared device), it now belongs to whoever registered it last.
async function subscribe(request, env, user) {
  const { subscription, label, timezone } = await readJson(request);
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!isPushEndpoint(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new HttpError(400, 'Invalid push subscription');
  }
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       label = excluded.label, fail_count = 0`,
  )
    .bind(endpoint, user.id, p256dh, auth, String(label || 'Device').slice(0, 80), Date.now())
    .run();
  if (timezone) await updateSettings(env, user.id, { timezone }).catch(() => {});
  return json({ ok: true, devices: await countDevices(env, user.id) });
}

async function unsubscribe(request, env, user) {
  const { endpoint } = await readJson(request);
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(endpoint ?? ''), user.id).run();
  return json({ ok: true, devices: await countDevices(env, user.id) });
}

async function testPush(request, env, user) {
  const { endpoint } = await readJson(request);
  const { language } = await getSettings(env, user.id);
  const report = await sendToDevices(env, user.id, testMessage(language), { endpoint: endpoint || undefined, ttl: 300 });
  if (!report.sent && !report.failed) {
    throw new HttpError(400, 'This device is not registered for notifications yet', 'no_device');
  }
  return json(report);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // Without logging in
  if (path === '/' || path === '/api/health') {
    return json({ ok: true, app: 'tutor-planner', needsSetup: (await countUsers(env)) === 0 });
  }
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/setup' && method === 'POST') return setup(request, env);
  if (path === '/api/join' && method === 'POST') return join(request, env);

  // Everything below works on the logged-in user's own data only.
  const user = await requireUser(request, env);

  if (path === '/api/data' && method === 'GET') return json(await getData(env, user));
  if (path === '/api/settings' && method === 'PUT') return json(await updateSettings(env, user.id, await readJson(request)));
  if (path === '/api/account/password' && method === 'POST') return changePassword(request, env, user);
  if (path === '/api/push/subscribe' && method === 'POST') return subscribe(request, env, user);
  if (path === '/api/push/unsubscribe' && method === 'POST') return unsubscribe(request, env, user);
  if (path === '/api/push/test' && method === 'POST') return testPush(request, env, user);

  // The owner's People screen
  if (path === '/api/admin/people' && method === 'GET') return listPeople(env, user);
  if (path === '/api/admin/invites' && method === 'POST') return addInvite(request, env, user);
  const invite = path.match(/^\/api\/admin\/invites\/([\w-]+)$/);
  if (invite && method === 'DELETE') return cancelInvite(env, user, invite[1]);
  const person = path.match(/^\/api\/admin\/users\/([\w-]+)(\/reset-password)?$/);
  if (person && person[2] && method === 'POST') return resetPassword(env, user, person[1]);
  if (person && !person[2] && method === 'DELETE') return removeUser(env, user, person[1]);

  // A repeating series of lessons or reminders, created in one go.
  const bulk = path.match(/^\/api\/(lessons|events)\/bulk$/);
  if (bulk && method === 'POST') {
    const { items } = await readJson(request);
    return json({ rows: await createSeries(env, bulk[1], items, user.id) }, 201);
  }

  const match = path.match(/^\/api\/(students|lessons|grades|homework|events)(?:\/([\w-]+))?$/);
  if (match) {
    const [, table, id] = match;
    if (!id && method === 'POST') return json(await createRow(env, table, await readJson(request), user.id), 201);
    if (id && method === 'PATCH') return json(await updateRow(env, table, id, await readJson(request), user.id));
    if (id && method === 'DELETE') {
      const deleted = await deleteRow(env, table, id, user.id, { following: url.searchParams.get('following') === '1' });
      return json({ ok: true, deleted });
    }
  }
  throw new HttpError(404, 'Not found', 'not_found');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      const known = err instanceof HttpError;
      const status = known ? err.status : 500;
      if (status === 500) console.error(err);
      response = json({ error: known ? err.message : 'Server error', code: known ? err.code : 'server_error' }, status);
    }
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  },

  // Runs every minute (see wrangler.toml) and sends any reminders that are due.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReminders(env, controller.scheduledTime ?? Date.now()));
  },
};
