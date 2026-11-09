import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, client, fakeSubscription } from './helpers.mjs';

test('health is public, everything else needs a login', async () => {
  const api = client(await makeEnv());
  assert.equal((await api.get('/api/health')).status, 200);
  assert.equal((await api.get('/api/data')).status, 401);
  assert.equal((await api.post('/api/students', { name: 'X' })).status, 401);
  assert.equal((await api.get('/api/data', { Authorization: 'Bearer 9999999999999.forged' })).status, 401);
});

test('the right username and password return a token that works; anything else does not', async () => {
  const api = client(await makeEnv());
  await api.login(); // creates the owner account
  api.logout();
  const bad = await api.post('/api/login', { username: 'owner', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'wrong_login');
  const nobody = await api.post('/api/login', { username: 'nobody', password: 'correct horse' });
  assert.equal(nobody.body.error, bad.body.error, 'same message, so usernames cannot be probed');

  const good = await api.post('/api/login', { username: '  Owner ', password: 'correct horse' });
  assert.equal(good.status, 200);
  const data = await api.get('/api/data', { Authorization: `Bearer ${good.body.token}` });
  assert.equal(data.status, 200);
  assert.equal(data.body.me.username, 'owner');
  assert.equal(data.body.me.is_admin, true);
  assert.deepEqual(data.body.settings.reminder_offsets, [180, 120, 60]);
  assert.equal(data.body.devices, 0);
  assert.match(data.body.vapidPublicKey, /^[A-Za-z0-9_-]{87}$/);
});

test('login locks for 15 minutes after 10 wrong attempts', async () => {
  const api = client(await makeEnv());
  await api.login();
  api.logout();
  for (let i = 0; i < 10; i++) assert.equal((await api.post('/api/login', { username: 'owner', password: `guess ${i}` })).status, 401);
  assert.equal((await api.post('/api/login', { username: 'owner', password: 'correct horse' })).status, 429);
});

test('CORS only answers the configured origins', async () => {
  const api = client(await makeEnv());
  const ok = await api.call('OPTIONS', '/api/data', undefined, { Origin: 'https://example.github.io' });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io');
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Authorization/);

  const evil = await api.call('OPTIONS', '/api/data', undefined, { Origin: 'https://evil.example' });
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);

  const err = await api.get('/api/data', { Origin: 'https://example.github.io' });
  assert.equal(err.status, 401);
  assert.equal(err.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io', 'errors carry CORS too');
});

test('students, lessons, grades and homework round-trip with validation', async () => {
  const api = client(await makeEnv());
  await api.login();

  assert.equal((await api.post('/api/students', { subject: 'Math' })).status, 400, 'name is required');
  const student = (await api.post('/api/students', { name: '  Arthas Menethil ', subject: 'Math', grade_level: '8th grade', price: '25' })).body;
  assert.equal(student.name, 'Arthas Menethil');
  assert.equal(student.price, 25);
  assert.equal(student.archived, 0);

  const unknown = await api.post('/api/lessons', { student_id: 'nope', start_at: 1 });
  assert.equal(unknown.status, 400, 'unknown student');
  assert.equal(unknown.body.code, 'ref_not_found', 'so the app knows to reload its data');
  assert.equal((await api.post('/api/lessons', { student_id: student.id })).status, 400, 'start time required');
  const start = Date.UTC(2026, 10, 8, 13, 0);
  const lesson = (await api.post('/api/lessons', { student_id: student.id, start_at: start, price: 25 })).body;
  assert.equal(lesson.status, 'scheduled');
  assert.equal(lesson.duration_min, 60);
  assert.equal(lesson.reminders_on, 1);
  assert.equal(lesson.remind_offsets, '[180,120,60]', 'new lessons copy the default reminder times');

  // Reminders switched off stay off when the lesson is moved.
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { reminders_on: false })).body.reminders_on, 0);
  const moved = (await api.patch(`/api/lessons/${lesson.id}`, { start_at: start + 2 * 3600_000 })).body;
  assert.equal(moved.start_at, start + 2 * 3600_000);
  assert.equal(moved.reminders_on, 0);

  // Each lesson can have its own reminder times.
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { remind_offsets: [30, 1440, 30, 0] })).body.remind_offsets, '[1440,30,0]');
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { remind_offsets: [] })).body.remind_offsets, '[]');
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { remind_offsets: [-1] })).status, 400);
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { remind_offsets: [20000] })).status, 400);
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { remind_offsets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).status, 400, 'at most 9');

  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { status: 'done' })).status, 400, 'bad status');
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { duration_min: null })).status, 400, 'length cannot be cleared');
  const paid = (await api.patch(`/api/lessons/${lesson.id}`, { status: 'completed', paid: true })).body;
  assert.equal(paid.paid, 1);
  assert.ok(paid.paid_at > 0);
  assert.equal((await api.patch(`/api/lessons/${lesson.id}`, { paid: false })).body.paid_at, null);

  const grade = (await api.post('/api/grades', { student_id: student.id, date: '2026-11-07', value: '6', title: 'Test: fractions' })).body;
  assert.equal(grade.value, '6');
  assert.equal((await api.post('/api/grades', { student_id: student.id, date: '7/11/2026', value: '6' })).status, 400);

  const hw = (await api.post('/api/homework', { student_id: student.id, lesson_id: lesson.id, text: 'Page 45, 1–10' })).body;
  assert.equal(hw.status, 'open');
  const done = (await api.patch(`/api/homework/${hw.id}`, { status: 'done' })).body;
  assert.ok(done.checked_at > 0);

  // Deleting the lesson keeps the homework; deleting the student removes everything.
  assert.equal((await api.del(`/api/lessons/${lesson.id}`)).status, 200);
  let data = (await api.get('/api/data')).body;
  assert.equal(data.lessons.length, 0);
  assert.equal(data.homework[0].lesson_id, null);

  assert.equal((await api.del(`/api/students/${student.id}`)).status, 200);
  data = (await api.get('/api/data')).body;
  assert.deepEqual([data.students.length, data.grades.length, data.homework.length], [0, 0, 0]);
  assert.equal((await api.del(`/api/students/${student.id}`)).status, 404);
});

test('settings are validated and merged with defaults', async () => {
  const api = client(await makeEnv());
  await api.login();
  const saved = await api.put('/api/settings', { reminder_offsets: [60, 180, 120, 60], currency: 'лв', timezone: 'Europe/Sofia', unknown: 1 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.reminder_offsets, [180, 120, 60]);
  assert.equal(saved.body.currency, 'лв');
  assert.equal(saved.body.timezone, 'Europe/Sofia');
  assert.equal(saved.body.default_duration, 60);
  assert.equal((await api.put('/api/settings', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await api.put('/api/settings', { reminder_offsets: [0] })).status, 400);
});

test('devices can register for notifications and send a test', async () => {
  const api = client(await makeEnv());
  await api.login();
  assert.equal((await api.post('/api/push/test', {})).status, 400, 'no device yet');
  assert.equal((await api.post('/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);

  const sub = fakeSubscription();
  const res = await api.post('/api/push/subscribe', { subscription: sub.json, label: 'iPhone', timezone: 'Europe/Sofia' });
  assert.equal(res.body.devices, 1);
  await api.post('/api/push/subscribe', { subscription: sub.json, label: 'iPhone' }); // same device again
  const data = (await api.get('/api/data')).body;
  assert.equal(data.devices, 1);
  assert.equal(data.settings.timezone, 'Europe/Sofia');

  assert.equal((await api.post('/api/push/unsubscribe', { endpoint: sub.json.endpoint })).body.devices, 0);
});

test('planner reminders round-trip with validation', async () => {
  const api = client(await makeEnv());
  await api.login();
  assert.equal((await api.post('/api/events', { start_at: 1 })).status, 400, 'title is required');
  assert.equal((await api.post('/api/events', { title: 'X', start_at: 1, remind_offsets: [-5] })).status, 400);
  const ev = (await api.post('/api/events', { title: ' Call the bank ', note: 'Card limit', start_at: Date.UTC(2026, 10, 9, 15) })).body;
  assert.equal(ev.title, 'Call the bank');
  assert.equal(ev.remind_offsets, '[0]', 'notifies at the time by default');
  assert.equal(ev.reminders_on, 1);
  assert.equal(ev.status, 'scheduled');
  assert.equal(ev.duration_min, null);
  const off = (await api.patch(`/api/events/${ev.id}`, { reminders_on: false })).body;
  assert.equal(off.reminders_on, 0);
  assert.equal(off.remind_offsets, '[0]', 'switching off keeps the chosen times');
  assert.equal((await api.patch(`/api/events/${ev.id}`, { remind_offsets: '60,15' })).body.remind_offsets, '[60,15]');
  assert.equal((await api.patch(`/api/events/${ev.id}`, { status: 'completed' })).body.status, 'completed');
  assert.equal((await api.patch(`/api/events/${ev.id}`, { status: 'cancelled' })).body.status, 'cancelled');
  assert.equal((await api.patch(`/api/events/${ev.id}`, { status: 'done' })).status, 400, 'same statuses as lessons');
  assert.equal((await api.get('/api/data')).body.events.length, 1);
  assert.equal((await api.del(`/api/events/${ev.id}`)).status, 200);
  assert.equal((await api.get('/api/data')).body.events.length, 0);
});

test('errors carry a code the app can translate', async () => {
  const api = client(await makeEnv());
  assert.equal((await api.post('/api/login', { username: 'x', password: 'nope' })).body.code, 'wrong_login');
  assert.equal((await api.get('/api/data')).body.code, 'not_logged_in');
  await api.login();
  assert.equal((await api.patch('/api/lessons/missing', { topic: 'x' })).body.code, 'not_found');
  assert.equal((await api.post('/api/students', {})).body.code, 'invalid');
  assert.equal((await api.put('/api/settings', { language: 'de' })).status, 400);
  assert.equal((await api.put('/api/settings', { language: 'bg' })).body.language, 'bg');
});
