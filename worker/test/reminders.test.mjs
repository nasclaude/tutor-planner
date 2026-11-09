import { test } from 'node:test';
import assert from 'node:assert/strict';
import ece from 'http_ece';
import { runReminders, untilText } from '../src/reminders.js';
import { makeEnv, client, fakeSubscription, capturePushes } from './helpers.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const T = Date.UTC(2026, 10, 8, 13, 0); // the lesson: 8 Nov 2026, 13:00 (UTC in these tests)

async function setup() {
  const env = await makeEnv();
  const api = client(env);
  await api.login();
  const sub = fakeSubscription();
  await api.post('/api/push/subscribe', { subscription: sub.json, label: 'iPhone', timezone: 'UTC' });
  const student = (await api.post('/api/students', { name: 'Arthas Menethil', subject: 'Math', grade_level: '8th grade' })).body;
  const lesson = (await api.post('/api/lessons', { student_id: student.id, start_at: T, topic: 'Fractions' })).body;
  return { env, api, sub, lesson };
}

const decrypt = (sub, call) =>
  JSON.parse(
    ece.decrypt(Buffer.from(call.init.body), { version: 'aes128gcm', privateKey: sub.ecdh, authSecret: sub.json.keys.auth }).toString(),
  );

test('reminds 3 h, 2 h and 1 h before the lesson, once each', async () => {
  const { env, sub, lesson } = await setup();
  const push = capturePushes();
  try {
    await runReminders(env, T - 4 * H);
    assert.equal(push.calls.length, 0, 'nothing 4 h before');

    await runReminders(env, T - 3 * H);
    assert.equal(push.calls.length, 1);
    const first = decrypt(sub, push.calls[0]);
    assert.equal(first.title, 'Lesson in 3 hours · 13:00');
    assert.equal(first.body, 'Arthas Menethil — Math, 8th grade\nTopic: Fractions');
    assert.equal(first.url, `#/lesson/${lesson.id}`);
    assert.equal(push.calls[0].init.headers['Content-Encoding'], 'aes128gcm');
    assert.match(push.calls[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    await runReminders(env, T - 3 * H); // a duplicate cron run
    await runReminders(env, T - 3 * H + MIN);
    await runReminders(env, T - 2.5 * H);
    assert.equal(push.calls.length, 1, 'no duplicates in between');

    await runReminders(env, T - 2 * H);
    assert.equal(decrypt(sub, push.calls[1]).title, 'Lesson in 2 hours · 13:00');
    await runReminders(env, T - H);
    assert.equal(decrypt(sub, push.calls[2]).title, 'Lesson in 1 hour · 13:00');

    await runReminders(env, T - 30 * MIN);
    await runReminders(env, T);
    await runReminders(env, T + 5 * MIN);
    assert.equal(push.calls.length, 3, 'exactly three reminders');
  } finally {
    push.restore();
  }
});

test('stopping reminders, cancelling or completing silences the lesson', async () => {
  for (const patch of [{ reminders_on: false }, { status: 'cancelled' }, { status: 'completed' }]) {
    const { env, api, lesson } = await setup();
    const push = capturePushes();
    try {
      await runReminders(env, T - 3 * H);
      await api.patch(`/api/lessons/${lesson.id}`, patch);
      await runReminders(env, T - 2 * H);
      await runReminders(env, T - H);
      assert.equal(push.calls.length, 1, JSON.stringify(patch));
    } finally {
      push.restore();
    }
  }
});

test('moving the lesson from 13:00 to 15:00 re-schedules the reminders', async () => {
  const { env, api, sub, lesson } = await setup();
  const push = capturePushes();
  try {
    await runReminders(env, T - 3 * H); // 10:00 -> "in 3 hours · 13:00"
    await api.patch(`/api/lessons/${lesson.id}`, { start_at: T + 2 * H });
    await runReminders(env, T - 2 * H); // 11:00: old 2 h mark, nothing for 15:00 yet
    assert.equal(push.calls.length, 1);
    await runReminders(env, T - H); // 12:00
    assert.equal(decrypt(sub, push.calls[1]).title, 'Lesson in 3 hours · 15:00');
    await runReminders(env, T); // 13:00
    await runReminders(env, T + H); // 14:00
    assert.deepEqual(
      push.calls.slice(1).map((c) => decrypt(sub, c).title),
      ['Lesson in 3 hours · 15:00', 'Lesson in 2 hours · 15:00', 'Lesson in 1 hour · 15:00'],
    );
  } finally {
    push.restore();
  }
});

test('a lesson added at the last minute gets no burst of stale reminders', async () => {
  const { env, sub } = await setup();
  const push = capturePushes();
  try {
    await runReminders(env, T - 2 * H + 15 * MIN); // the 2 h mark passed 15 min ago -> skipped
    assert.equal(push.calls.length, 0);
    await runReminders(env, T - H + 5 * MIN); // the 1 h mark passed 5 min ago -> still sent
    assert.equal(decrypt(sub, push.calls[0]).title, 'Lesson in 55 min · 13:00');
  } finally {
    push.restore();
  }
});

test('shows the time in the phone’s time zone', async () => {
  const { env, api, sub } = await setup();
  await api.put('/api/settings', { timezone: 'Europe/Sofia' }); // UTC+2 in November
  const push = capturePushes();
  try {
    await runReminders(env, T - 3 * H);
    assert.equal(decrypt(sub, push.calls[0]).title, 'Lesson in 3 hours · 15:00');
  } finally {
    push.restore();
  }
});

test('devices the push service reports as gone are removed', async () => {
  const { env, api } = await setup();
  const push = capturePushes(410);
  try {
    await runReminders(env, T - 3 * H);
    assert.equal((await api.get('/api/data')).body.devices, 0);
  } finally {
    push.restore();
  }
});

test('untilText reads naturally', () => {
  assert.equal(untilText(180 * MIN), '3 hours');
  assert.equal(untilText(60 * MIN), '1 hour');
  assert.equal(untilText(90 * MIN), '1 h 30 min');
  assert.equal(untilText(15 * MIN), '15 min');
  assert.equal(untilText(1440 * MIN), '1 day');
});

const E = Date.UTC(2026, 10, 9, 15, 0); // a planner reminder on 9 Nov at 15:00

test('planner reminders notify N minutes before or at the time, once each', async () => {
  const { env, api, sub } = await setup();
  const bank = (await api.post('/api/events', { title: 'Call the bank', note: 'Ask about the card', start_at: E, remind_offsets: [15] })).body;
  await api.post('/api/events', { title: 'Pick up books', start_at: E + H }); // default: at the time
  await api.post('/api/events', { title: 'No alert', start_at: E, reminders_on: false });
  const push = capturePushes();
  try {
    await runReminders(env, E - 20 * MIN);
    assert.equal(push.calls.length, 0);
    await runReminders(env, E - 15 * MIN);
    await runReminders(env, E - 14 * MIN);
    assert.equal(push.calls.length, 1, 'once');
    const first = decrypt(sub, push.calls[0]);
    assert.equal(first.title, 'Call the bank · 15:00');
    assert.equal(first.body, 'In 15 min\nAsk about the card');
    assert.equal(first.url, `#/event/${bank.id}`);
    await runReminders(env, E + H);
    const second = decrypt(sub, push.calls[1]);
    assert.equal(second.title, 'Pick up books · 16:00');
    assert.equal(second.body, 'Now');
    await runReminders(env, E + H + MIN);
    assert.equal(push.calls.length, 2, 'the item without a reminder stays silent');
  } finally {
    push.restore();
  }
});

test('completed or cancelled planner reminders stay quiet, moved ones re-arm', async () => {
  const { env, api, sub } = await setup();
  const a = (await api.post('/api/events', { title: 'Dentist', start_at: E, remind_offsets: [60] })).body;
  const b = (await api.post('/api/events', { title: 'Buy ink', start_at: E, remind_offsets: [0] })).body;
  await api.patch(`/api/events/${b.id}`, { status: 'completed' });
  const c = (await api.post('/api/events', { title: 'Haircut', start_at: E, remind_offsets: [0] })).body;
  await api.patch(`/api/events/${c.id}`, { status: 'cancelled' });
  const push = capturePushes();
  try {
    await runReminders(env, E - H); // dentist: 1 h before
    await api.patch(`/api/events/${a.id}`, { start_at: E + 2 * H }); // moved to 17:00
    await runReminders(env, E); // "buy ink" is completed, "haircut" cancelled -> nothing
    await runReminders(env, E + H); // dentist again, 1 h before the new time
    assert.deepEqual(push.calls.map((c) => decrypt(sub, c).title), ['Dentist · 15:00', 'Dentist · 17:00']);
  } finally {
    push.restore();
  }
});

test('notifications are in Bulgarian when the app language is BG', async () => {
  const { env, api, sub } = await setup();
  await api.put('/api/settings', { language: 'bg' });
  await api.post('/api/events', { title: 'Родителска среща', start_at: E, remind_offsets: [30] });
  const push = capturePushes();
  try {
    await runReminders(env, T - 3 * H);
    const lesson = decrypt(sub, push.calls[0]);
    assert.equal(lesson.title, 'Урок след 3 часа · 13:00');
    assert.equal(lesson.body, 'Arthas Menethil — Math, 8th grade\nТема: Fractions');
    await runReminders(env, T - H);
    assert.equal(decrypt(sub, push.calls[1]).title, 'Урок след 1 час · 13:00');
    await runReminders(env, E - 30 * MIN);
    const event = decrypt(sub, push.calls[2]);
    assert.equal(event.title, 'Родителска среща · 15:00');
    assert.equal(event.body, 'След 30 мин');
  } finally {
    push.restore();
  }
});

test('untilText in Bulgarian', () => {
  assert.equal(untilText(180 * MIN, 'bg'), '3 часа');
  assert.equal(untilText(60 * MIN, 'bg'), '1 час');
  assert.equal(untilText(90 * MIN, 'bg'), '1 ч 30 мин');
  assert.equal(untilText(1440 * MIN, 'bg'), '1 ден');
  assert.equal(untilText(2880 * MIN, 'bg'), '2 дни');
});

test('each lesson follows its own reminder times', async () => {
  const { env, api, sub, lesson } = await setup();
  const student = (await api.get('/api/data')).body.students[0];
  // Lesson A: only 30 minutes before and at the start. Lesson B (same day, 16:00): reminders off.
  await api.patch(`/api/lessons/${lesson.id}`, { remind_offsets: [30, 0] });
  await api.post('/api/lessons', { student_id: student.id, start_at: T + 3 * H, reminders_on: false });
  const push = capturePushes();
  try {
    for (const at of [T - 3 * H, T - 2 * H, T - H, T + 2 * H, T + 3 * H]) await runReminders(env, at);
    assert.equal(push.calls.length, 0, 'none of the default times, and nothing for the switched-off lesson');
    await runReminders(env, T - 30 * MIN);
    await runReminders(env, T);
    assert.deepEqual(push.calls.map((c) => decrypt(sub, c).title), ['Lesson in 30 min · 13:00', 'Lesson starting now · 13:00']);
  } finally {
    push.restore();
  }
});

test('a planner reminder can notify several times, and be switched off and on', async () => {
  const { env, api, sub } = await setup();
  const ev = (await api.post('/api/events', { title: 'Exam day', start_at: E, remind_offsets: [1440, 60] })).body;
  const push = capturePushes();
  try {
    await runReminders(env, E - 1440 * MIN);
    assert.equal(decrypt(sub, push.calls[0]).body, 'In 1 day');
    await api.patch(`/api/events/${ev.id}`, { reminders_on: false });
    await runReminders(env, E - H);
    assert.equal(push.calls.length, 1, 'switched off: the 1 h reminder is skipped');
    await api.patch(`/api/events/${ev.id}`, { reminders_on: true, start_at: E + H }); // back on, moved to 16:00
    await runReminders(env, E);
    assert.equal(decrypt(sub, push.calls[1]).title, 'Exam day · 16:00');
  } finally {
    push.restore();
  }
});
