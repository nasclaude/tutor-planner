import { test } from 'node:test';
import assert from 'node:assert/strict';
import ece from 'http_ece';
import { runReminders } from '../src/reminders.js';
import { makeEnv, client, fakeSubscription, capturePushes } from './helpers.mjs';

const H = 3_600_000;
const T = Date.UTC(2026, 10, 12, 13, 0);

test('first-time setup creates the owner, needs the setup code, and only works once', async () => {
  const env = await makeEnv();
  const api = client(env);
  assert.equal((await api.get('/api/health')).body.needsSetup, true);
  const wrong = await api.post('/api/setup', { code: 'guess', name: 'Me', username: 'myname', password: 'long enough' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'wrong_setup_code');
  assert.equal((await api.post('/api/setup', { code: 'setup-code', name: 'Me', username: 'myname', password: 'short' })).body.code, 'weak_password');
  assert.equal((await api.post('/api/setup', { code: 'setup-code', name: 'Me', username: 'a b', password: 'long enough' })).body.code, 'bad_username');

  const ok = await api.post('/api/setup', { code: 'setup-code', name: 'Me', username: 'MyName', password: 'long enough' });
  assert.equal(ok.status, 201);
  api.setToken(ok.body.token);
  const me = (await api.get('/api/data')).body.me;
  assert.deepEqual([me.username, me.is_admin], ['myname', true]);
  assert.equal((await api.get('/api/health')).body.needsSetup, false);
  assert.equal((await api.post('/api/setup', { code: 'setup-code', name: 'X', username: 'x', password: 'long enough' })).body.code, 'already_set_up');
});

test('data from before accounts existed is taken over by the owner', async () => {
  const env = await makeEnv();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO students (id, name, created_at, updated_at) VALUES ('old', 'Old student', ?, ?)").bind(now, now).run();
  await env.DB.prepare("INSERT INTO user_settings (user_id, key, value) VALUES ('', 'language', '\"bg\"')").run();
  const api = client(env);
  await api.login();
  const data = (await api.get('/api/data')).body;
  assert.deepEqual(data.students.map((s) => s.name), ['Old student']);
  assert.equal(data.settings.language, 'bg');
});

test('invited people join with a code that works once and expires', async () => {
  const env = await makeEnv();
  const owner = client(env);
  await owner.login();
  const invite = (await owner.post('/api/admin/invites', { note: 'Jaina' })).body;
  assert.match(invite.code, /^[A-Z2-9]{8}$/);

  const guest = client(env);
  assert.equal((await guest.post('/api/join', { code: 'NOPE1234', name: 'J', username: 'jaina', password: 'long enough' })).body.code, 'invite_invalid');
  const taken = await guest.post('/api/join', { code: invite.code, name: 'J', username: 'owner', password: 'long enough' });
  assert.equal(taken.body.code, 'username_taken');
  // A failed attempt leaves the code usable; dashes and lower case are fine.
  const pretty = `${invite.code.slice(0, 4)}-${invite.code.slice(4)}`.toLowerCase();
  const joined = await guest.post('/api/join', { code: pretty, name: 'Jaina', username: 'jaina', password: 'long enough' });
  assert.equal(joined.status, 201);
  guest.setToken(joined.body.token);
  const me = (await guest.get('/api/data')).body.me;
  assert.deepEqual([me.name, me.is_admin], ['Jaina', false]);
  assert.equal((await client(env).post('/api/join', { code: invite.code, name: 'X', username: 'xx', password: 'long enough' })).body.code, 'invite_invalid', 'used once');

  const people = (await owner.get('/api/admin/people')).body;
  assert.deepEqual(people.users.map((u) => u.username), ['owner', 'jaina']);
  assert.equal(people.invites.length, 0);
  assert.equal((await guest.get('/api/admin/people')).body.code, 'admin_only');
  assert.equal((await guest.post('/api/admin/invites', {})).status, 403);

  const old = (await owner.post('/api/admin/invites', {})).body;
  await env.DB.prepare('UPDATE invites SET expires_at = 1 WHERE code = ?').bind(old.code).run();
  assert.equal((await client(env).post('/api/join', { code: old.code, name: 'X', username: 'xx', password: 'long enough' })).body.code, 'invite_invalid', 'expired');
});

test("nobody can see, change or use anyone else's data", async () => {
  const env = await makeEnv();
  const a = client(env);
  await a.login('owner');
  const b = client(env);
  await b.login('bob');

  const student = (await a.post('/api/students', { name: 'Arthas' })).body;
  const lesson = (await a.post('/api/lessons', { student_id: student.id, start_at: T })).body;
  const note = (await a.post('/api/events', { title: 'Private note', start_at: T })).body;
  await a.put('/api/settings', { language: 'bg' });

  const seen = (await b.get('/api/data')).body;
  assert.deepEqual([seen.students.length, seen.lessons.length, seen.events.length], [0, 0, 0], "B sees none of A's data");
  assert.equal(seen.settings.language, 'en', 'settings are per person');

  assert.equal((await b.patch(`/api/lessons/${lesson.id}`, { topic: 'hacked' })).status, 404);
  assert.equal((await b.del(`/api/events/${note.id}`)).status, 404);
  assert.equal((await b.del(`/api/students/${student.id}`)).status, 404);
  assert.equal((await b.post('/api/lessons', { student_id: student.id, start_at: T })).body.code, 'ref_not_found', "can't attach to A's student");
  assert.equal((await b.post('/api/lessons/bulk', { items: [{ student_id: student.id, start_at: T }] })).body.code, 'ref_not_found');
  assert.equal((await b.post('/api/homework', { student_id: student.id, text: 'x' })).body.code, 'ref_not_found');

  const mine = (await a.get('/api/data')).body;
  assert.equal(mine.lessons[0].topic, null, 'untouched');
  assert.equal(mine.events.length, 1);
  assert.equal(mine.students.length, 1);
});

test("reminders only go to the owner's own phones", async () => {
  const env = await makeEnv();
  const a = client(env);
  await a.login('owner');
  const b = client(env);
  await b.login('bob');
  const phoneA = fakeSubscription();
  const phoneB = fakeSubscription();
  await a.post('/api/push/subscribe', { subscription: phoneA.json, timezone: 'UTC' });
  await b.post('/api/push/subscribe', { subscription: phoneB.json, timezone: 'UTC' });
  const sa = (await a.post('/api/students', { name: 'Arthas' })).body;
  await a.post('/api/lessons', { student_id: sa.id, start_at: T });
  await b.post('/api/events', { title: "Bob's dentist", start_at: T, remind_offsets: [180] });

  const push = capturePushes();
  try {
    await runReminders(env, T - 3 * H);
    const to = (endpoint) => push.calls.filter((c) => c.url === endpoint);
    assert.equal(to(phoneA.json.endpoint).length, 1);
    assert.equal(to(phoneB.json.endpoint).length, 1);
    const msgA = JSON.parse(ece.decrypt(Buffer.from(to(phoneA.json.endpoint)[0].init.body), { version: 'aes128gcm', privateKey: phoneA.ecdh, authSecret: phoneA.json.keys.auth }));
    const msgB = JSON.parse(ece.decrypt(Buffer.from(to(phoneB.json.endpoint)[0].init.body), { version: 'aes128gcm', privateKey: phoneB.ecdh, authSecret: phoneB.json.keys.auth }));
    assert.match(msgA.body, /Arthas/);
    assert.match(msgB.title, /Bob's dentist/);
  } finally {
    push.restore();
  }

  // A shared phone: when B registers it, it stops getting A's reminders.
  await b.post('/api/push/subscribe', { subscription: phoneA.json });
  assert.equal((await a.get('/api/data')).body.devices, 0);
  assert.equal((await b.get('/api/data')).body.devices, 2);
});

test('the owner can reset a forgotten password; the person then picks a new one', async () => {
  const env = await makeEnv();
  const owner = client(env);
  await owner.login('owner');
  const bob = client(env);
  const oldToken = await bob.login('bob', 'first password');
  const bobId = (await bob.get('/api/data')).body.me.id;

  assert.equal((await bob.post(`/api/admin/users/${bobId}/reset-password`, {})).status, 403, 'only the owner');
  const { tempPassword } = (await owner.post(`/api/admin/users/${bobId}/reset-password`, {})).body;
  assert.match(tempPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  bob.setToken(oldToken);
  assert.equal((await bob.get('/api/data')).status, 401, 'old logins stop working');

  const login = (await bob.post('/api/login', { username: 'bob', password: tempPassword })).body;
  bob.setToken(login.token);
  assert.equal((await bob.get('/api/data')).body.me.must_change_password, true);
  assert.equal((await bob.post('/api/account/password', { current: 'wrong', next: 'a new password' })).body.code, 'wrong_current_password');
  const changed = (await bob.post('/api/account/password', { current: tempPassword, next: 'a new password' })).body;
  bob.setToken(changed.token);
  assert.equal((await bob.get('/api/data')).body.me.must_change_password, false);
  assert.equal((await bob.post('/api/login', { username: 'bob', password: 'a new password' })).status, 200);
});

test("removing someone deletes their account and all their data, and nobody else's", async () => {
  const env = await makeEnv();
  const owner = client(env);
  await owner.login('owner');
  const bob = client(env);
  await bob.login('bob');
  const bobId = (await bob.get('/api/data')).body.me.id;
  const sb = (await bob.post('/api/students', { name: 'Bob student' })).body;
  await bob.post('/api/lessons', { student_id: sb.id, start_at: T });
  await bob.post('/api/events', { title: 'x', start_at: T });
  await owner.post('/api/students', { name: 'Owner student' });
  const ownerId = (await owner.get('/api/data')).body.me.id;

  assert.equal((await owner.del(`/api/admin/users/${ownerId}`)).body.code, 'not_on_yourself');
  assert.equal((await owner.del(`/api/admin/users/${bobId}`)).status, 200);
  assert.equal((await bob.get('/api/data')).status, 401);
  for (const table of ['students', 'lessons', 'events']) {
    assert.equal(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(bobId).first('n'), 0, table);
  }
  assert.equal((await owner.get('/api/data')).body.students.length, 1);
});
