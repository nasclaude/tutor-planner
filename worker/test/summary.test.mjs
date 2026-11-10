import { test } from 'node:test';
import assert from 'node:assert/strict';
import ece from 'http_ece';
import { runReminders } from '../src/reminders.js';
import { buildSummary } from '../src/summary.js';
import { localDay, localClock } from '../src/localtime.js';
import { makeEnv, client, fakeSubscription, capturePushes } from './helpers.mjs';

const MIN = 60_000;
const H = 60 * MIN;
// Sofia is UTC+2 in November: local 07:30 on Tue 10 Nov 2026 is 05:30 UTC.
const SUMMARY_AT = Date.UTC(2026, 10, 10, 5, 30);
const local = (h, m = 0, day = 10) => Date.UTC(2026, 10, day, h - 2, m);

const decrypt = (sub, call) =>
  JSON.parse(ece.decrypt(Buffer.from(call.init.body), { version: 'aes128gcm', privateKey: sub.ecdh, authSecret: sub.json.keys.auth }).toString());

async function setup({ summary = '07:30', timezone = 'Europe/Sofia' } = {}) {
  const env = await makeEnv();
  const api = client(env);
  await api.login();
  const sub = fakeSubscription();
  await api.post('/api/push/subscribe', { subscription: sub.json, label: 'iPhone', timezone });
  await api.put('/api/settings', { daily_summary: summary });
  const arthas = (await api.post('/api/students', { name: 'Arthas Menethil' })).body;
  const jaina = (await api.post('/api/students', { name: 'Jaina Proudmoore' })).body;
  const lesson = (start, student = arthas, extra = {}) => api.post('/api/lessons', { student_id: student.id, start_at: start, reminders_on: false, ...extra });
  return { env, api, sub, arthas, jaina, lesson };
}

const summaries = (sub, push) => push.calls.map((c) => decrypt(sub, c)).filter((p) => p.tag === 'summary');

test('local days follow the time zone, including the night the clocks change', () => {
  assert.deepEqual(localDay(SUMMARY_AT, 'Europe/Sofia'), { start: Date.UTC(2026, 10, 9, 22), end: Date.UTC(2026, 10, 10, 22), day: '2026-11-10' });
  // 29 March 2026: clocks go forward at 03:00, so the day is 23 hours long.
  const spring = localDay(Date.UTC(2026, 2, 29, 10), 'Europe/Sofia');
  assert.equal(spring.start, Date.UTC(2026, 2, 28, 22));
  assert.equal(spring.end, Date.UTC(2026, 2, 29, 21));
  assert.equal(localClock(SUMMARY_AT, 'Europe/Sofia').minutes, 7 * 60 + 30);
  assert.equal(localClock(SUMMARY_AT, 'Not/AZone').day, '2026-11-10', 'an unknown zone falls back to UTC');
});

test('the summary lists the day in time order, in English and Bulgarian', () => {
  const plan = {
    lessons: [
      { start_at: local(13), name: 'Arthas Menethil', topic: 'Fractions' },
      { start_at: local(9), name: 'Jaina Proudmoore', topic: null },
    ],
    events: [{ start_at: local(10, 30), title: 'Call the bank' }],
    unmarked: 2,
  };
  assert.deepEqual(buildSummary(plan, 'Europe/Sofia', 'en'), {
    title: 'Today: 2 lessons · 1 reminder',
    body: '09:00 Jaina Proudmoore\n10:30 Call the bank\n13:00 Arthas Menethil · Fractions\n2 earlier lessons still need marking',
    url: '#/',
    tag: 'summary',
  });
  const bg = buildSummary({ ...plan, unmarked: 1 }, 'Europe/Sofia', 'bg');
  assert.equal(bg.title, 'Днес: 2 урока · 1 напомняне');
  assert.ok(bg.body.endsWith('1 минал урок чака отбелязване'));

  const busy = { lessons: Array.from({ length: 8 }, (_, i) => ({ start_at: local(8 + i), name: `Student ${i + 1}` })), events: [], unmarked: 0 };
  const lines = buildSummary(busy, 'Europe/Sofia', 'en').body.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines.at(-1), '+3 more');

  assert.deepEqual(
    [buildSummary({ lessons: [], events: [], unmarked: 0 }, 'UTC', 'en').title, buildSummary({ lessons: [], events: [], unmarked: 0 }, 'UTC', 'bg').body],
    ['Nothing planned today', 'Приятен свободен ден.'],
  );
});

test('sends the summary at the chosen local time, once, with only that local day', async () => {
  const { env, api, sub, arthas, jaina, lesson } = await setup();
  await lesson(local(13), arthas, { topic: 'Fractions' });
  await lesson(local(9), jaina);
  await lesson(local(0, 30, 11)); // 00:30 tomorrow (still the 10th in UTC): not today
  await lesson(local(16, 0, 9)); // yesterday, never marked
  const cancelled = (await lesson(local(15))).body;
  await api.patch(`/api/lessons/${cancelled.id}`, { status: 'cancelled' });
  await api.post('/api/events', { title: 'Call the bank', start_at: local(10, 30) });
  const push = capturePushes();
  try {
    await runReminders(env, SUMMARY_AT - MIN);
    assert.equal(summaries(sub, push).length, 0, 'not before 07:30');

    await runReminders(env, SUMMARY_AT);
    const [summary, ...rest] = summaries(sub, push);
    assert.equal(rest.length, 0);
    assert.equal(summary.title, 'Today: 2 lessons · 1 reminder');
    assert.equal(summary.body, '09:00 Jaina Proudmoore\n10:30 Call the bank\n13:00 Arthas Menethil · Fractions\n1 earlier lesson still needs marking');
    assert.equal(summary.badge, 1, 'the app icon shows the lesson still to mark');

    await runReminders(env, SUMMARY_AT); // a duplicate cron run
    await runReminders(env, SUMMARY_AT + 10 * MIN);
    await runReminders(env, SUMMARY_AT + 3 * H);
    assert.equal(summaries(sub, push).length, 1, 'only once a day');

    await runReminders(env, SUMMARY_AT + 24 * H);
    assert.equal(summaries(sub, push).length, 2, 'again the next morning');
  } finally {
    push.restore();
  }
});

test('a time set a little late still sends today; much later waits for tomorrow', async () => {
  const { env, sub, lesson } = await setup();
  await lesson(local(13));
  const push = capturePushes();
  try {
    await runReminders(env, SUMMARY_AT + 29 * MIN);
    assert.equal(summaries(sub, push).length, 1);
  } finally {
    push.restore();
  }
  const late = await setup();
  await late.lesson(local(13));
  const push2 = capturePushes();
  try {
    await runReminders(late.env, SUMMARY_AT + 31 * MIN);
    assert.equal(summaries(late.sub, push2).length, 0);
  } finally {
    push2.restore();
  }
});

test('stays quiet when it is off, or when there is nothing to say', async () => {
  const off = await setup({ summary: '' });
  await off.lesson(local(13));
  const empty = await setup();
  const push = capturePushes();
  try {
    await runReminders(off.env, SUMMARY_AT);
    await runReminders(empty.env, SUMMARY_AT);
    assert.equal(push.calls.length, 0);
  } finally {
    push.restore();
  }
});

test('reminders carry the app icon number, unless it is switched off', async () => {
  const { env, api, sub, lesson } = await setup({ summary: '' });
  await lesson(local(9, 0, 9)); // yesterday, never marked
  const next = (await lesson(local(13), undefined, { reminders_on: true })).body;
  const push = capturePushes();
  try {
    await runReminders(env, next.start_at - 3 * H);
    assert.equal(decrypt(sub, push.calls[0]).badge, 1);
    await api.put('/api/settings', { app_badge: false });
    await runReminders(env, next.start_at - 2 * H);
    assert.equal(decrypt(sub, push.calls[1]).badge, undefined);
  } finally {
    push.restore();
  }
});

test('"send it now" delivers today\'s summary to this device', async () => {
  const { api, sub, lesson } = await setup();
  await lesson(Date.now() + H);
  const push = capturePushes();
  try {
    const res = await api.post('/api/push/summary', { endpoint: sub.json.endpoint });
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, 1);
    assert.equal(decrypt(sub, push.calls[0]).tag, 'summary');
  } finally {
    push.restore();
  }
});

test('settings check the summary time and the icon switch', async () => {
  const { api } = await setup();
  assert.equal((await api.put('/api/settings', { daily_summary: '25:00' })).status, 400);
  assert.equal((await api.put('/api/settings', { daily_summary: '7:30' })).status, 400);
  assert.equal((await api.put('/api/settings', { app_badge: 'yes' })).status, 400);
  const ok = await api.put('/api/settings', { daily_summary: '06:30', app_badge: false });
  assert.equal(ok.body.daily_summary, '06:30');
  assert.equal(ok.body.app_badge, false);
  const off = await api.put('/api/settings', { daily_summary: '' });
  assert.equal(off.body.daily_summary, '');
});
