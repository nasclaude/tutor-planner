import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, client } from './helpers.mjs';

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 10, 15, 0); // Tuesday 10 Nov 2026

// Counts every query the worker sends to the database (a batch counts each statement).
function countQueries(env) {
  let count = 0;
  const db = env.DB;
  const wrapStatement = (stmt) => ({
    ...stmt,
    bind: (...args) => wrapStatement(stmt.bind(...args)),
    first: (...a) => (count++, stmt.first(...a)),
    all: (...a) => (count++, stmt.all(...a)),
    run: (...a) => (count++, stmt.run(...a)),
    _inner: stmt,
  });
  env.DB = {
    ...db,
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    batch: (stmts) => ((count += stmts.length), db.batch(stmts.map((s) => s._inner ?? s))),
  };
  return () => count;
}

async function setup() {
  const env = await makeEnv();
  const api = client(env);
  await api.login();
  const student = (await api.post('/api/students', { name: 'Arthas Menethil', price: 25 })).body;
  return { env, api, student };
}

test('a weekly series for a year is saved as separate lessons that share a series id', async () => {
  const { env, api, student } = await setup();
  const items = Array.from({ length: 53 }, (_, i) => ({ student_id: student.id, start_at: START + i * 7 * DAY, price: 25, topic: 'Algebra' }));
  const queries = countQueries(env);
  const res = await api.post('/api/lessons/bulk', { items });
  assert.equal(res.status, 201);
  assert.ok(queries() <= 20, `used ${queries()} database queries; the free plan allows 50`);
  const rows = res.body.rows;
  assert.equal(rows.length, 53);
  assert.equal(new Set(rows.map((r) => r.id)).size, 53, 'every lesson has its own id');
  assert.equal(new Set(rows.map((r) => r.series_id)).size, 1, 'one series');
  assert.deepEqual(rows.map((r) => r.start_at), items.map((i) => i.start_at));
  assert.ok(rows.every((r) => r.remind_offsets === '[180,120,60]' && r.price === 25 && r.status === 'scheduled'));

  // Each one can still be edited on its own.
  const moved = (await api.patch(`/api/lessons/${rows[3].id}`, { start_at: rows[3].start_at + 3_600_000, topic: 'Test prep' })).body;
  assert.equal(moved.topic, 'Test prep');
  const data = (await api.get('/api/data')).body;
  assert.equal(data.lessons.filter((l) => l.topic === 'Algebra').length, 52);
});

test('reminders can repeat too, and nothing is saved if one item is invalid', async () => {
  const { api } = await setup();
  const ok = await api.post('/api/events/bulk', { items: [0, 1, 2].map((m) => ({ title: 'Pay rent', start_at: START + m * 30 * DAY, remind_offsets: [1440] })) });
  assert.equal(ok.body.rows.length, 3);
  assert.ok(ok.body.rows.every((r) => r.remind_offsets === '[1440]'));

  const bad = await api.post('/api/events/bulk', { items: [{ title: 'A', start_at: START }, { start_at: START + DAY }] });
  assert.equal(bad.status, 400);
  assert.equal((await api.get('/api/data')).body.events.length, 3, 'the invalid series left nothing behind');
  assert.equal((await api.post('/api/events/bulk', { items: [] })).status, 400);
  assert.equal((await api.post('/api/events/bulk', { items: Array.from({ length: 61 }, () => ({ title: 'x', start_at: START })) })).status, 400);
  assert.equal((await api.post('/api/students/bulk', { items: [{ name: 'x' }] })).status, 404, 'only lessons and reminders repeat');
});

test('deleting "this and all following" removes only the later items of that series', async () => {
  const { api, student } = await setup();
  const series = (await api.post('/api/lessons/bulk', { items: Array.from({ length: 8 }, (_, i) => ({ student_id: student.id, start_at: START + i * 7 * DAY })) })).body.rows;
  const other = (await api.post('/api/lessons', { student_id: student.id, start_at: START + 50 * DAY })).body;
  const hw = (await api.post('/api/homework', { student_id: student.id, lesson_id: series[6].id, text: 'Page 10' })).body;

  const one = await api.del(`/api/lessons/${series[1].id}`);
  assert.deepEqual(one.body.deleted, [series[1].id], 'without the flag only one goes');

  const res = await api.del(`/api/lessons/${series[5].id}?following=1`);
  assert.deepEqual(res.body.deleted.sort(), [series[5].id, series[6].id, series[7].id].sort());
  const data = (await api.get('/api/data')).body;
  assert.deepEqual(
    data.lessons.map((l) => l.id).sort(),
    [series[0].id, series[2].id, series[3].id, series[4].id, other.id].sort(),
    'earlier lessons and lessons outside the series stay',
  );
  assert.equal(data.homework.find((h) => h.id === hw.id).lesson_id, null, 'homework is kept, just unlinked');
});
