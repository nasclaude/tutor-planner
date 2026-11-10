// The morning summary: one notification at a chosen local time with the day's lessons and reminders,
// plus the number for the app icon (past lessons still waiting to be marked done or cancelled).
import { MINUTE, HOUR, DAY } from './util.js';
import { formatTime, localClock, localDay } from './localtime.js';
import { sendToDevices } from './push.js';

// The summary may still go out this long after its time (a late cron run, or the time was just set).
export const SUMMARY_WINDOW_MIN = 30;
const MAX_LINES = 6;

const TEXT = {
  en: {
    lessons: (n) => (n === 1 ? '1 lesson' : `${n} lessons`),
    reminders: (n) => (n === 1 ? '1 reminder' : `${n} reminders`),
    today: (what) => `Today: ${what}`,
    nothing: 'Nothing planned today',
    free: 'Enjoy the free day.',
    more: (n) => `+${n} more`,
    unmarked: (n) => (n === 1 ? '1 earlier lesson still needs marking' : `${n} earlier lessons still need marking`),
  },
  bg: {
    lessons: (n) => (n === 1 ? '1 урок' : `${n} урока`),
    reminders: (n) => (n === 1 ? '1 напомняне' : `${n} напомняния`),
    today: (what) => `Днес: ${what}`,
    nothing: 'Нищо планирано за днес',
    free: 'Приятен свободен ден.',
    more: (n) => `и още ${n}`,
    unmarked: (n) => (n === 1 ? '1 минал урок чака отбелязване' : `${n} минали урока чакат отбелязване`),
  },
};
const text = (lang) => TEXT[lang] ?? TEXT.en;

// "Today: 3 lessons · 1 reminder" with one line per item: "13:00 Arthas Menethil · Fractions".
export function buildSummary({ lessons, events, unmarked }, timeZone, lang = 'en') {
  const T = text(lang);
  const items = [
    ...lessons.map((l) => ({ at: l.start_at, label: l.topic ? `${l.name} · ${l.topic}` : l.name })),
    ...events.map((e) => ({ at: e.start_at, label: e.title })),
  ].sort((a, b) => a.at - b.at);
  const shown = items.length > MAX_LINES ? items.slice(0, MAX_LINES - 1) : items;
  const lines = shown.map((i) => `${formatTime(i.at, timeZone)} ${i.label}`);
  if (shown.length < items.length) lines.push(T.more(items.length - shown.length));
  if (unmarked) lines.push(T.unmarked(unmarked));
  const counts = [lessons.length && T.lessons(lessons.length), events.length && T.reminders(events.length)].filter(Boolean);
  return {
    title: counts.length ? T.today(counts.join(' · ')) : T.nothing,
    body: lines.length ? lines.join('\n') : T.free,
    url: '#/',
    tag: 'summary',
  };
}

const unmarkedQuery = (db, userId, now) =>
  db
    .prepare(`SELECT COUNT(*) AS n FROM lessons WHERE user_id = ? AND status = 'scheduled' AND start_at + COALESCE(duration_min, 60) * ? <= ?`)
    .bind(userId, MINUTE, now);

// Past lessons still waiting to be marked done or cancelled (the number on the app icon).
export async function unmarkedCount(env, userId, now = Date.now()) {
  return (await unmarkedQuery(env.DB, userId, now).first('n')) ?? 0;
}

// Everything scheduled for the person's local "today", plus the unmarked count.
export async function dayPlan(env, userId, now, timeZone) {
  const { start, end } = localDay(now, timeZone);
  const db = env.DB;
  const [lessons, events, unmarked] = await db.batch([
    db
      .prepare(
        `SELECT l.start_at, l.topic, s.name FROM lessons l JOIN students s ON s.id = l.student_id
          WHERE l.user_id = ? AND l.status = 'scheduled' AND l.start_at >= ? AND l.start_at < ? ORDER BY l.start_at`,
      )
      .bind(userId, start, end),
    db
      .prepare(`SELECT start_at, title FROM events WHERE user_id = ? AND status = 'scheduled' AND start_at >= ? AND start_at < ? ORDER BY start_at`)
      .bind(userId, start, end),
    unmarkedQuery(db, userId, now),
  ]);
  return { lessons: lessons.results, events: events.results, unmarked: unmarked.results[0]?.n ?? 0 };
}

// The summary notification for right now. `empty`: nothing planned and nothing to mark.
export async function summaryFor(env, userId, now, settings) {
  const plan = await dayPlan(env, userId, now, settings.timezone);
  const payload = buildSummary(plan, settings.timezone, settings.language);
  if (settings.app_badge) payload.badge = plan.unmarked;
  return { payload, empty: !plan.lessons.length && !plan.events.length && !plan.unmarked };
}

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// Called every minute: sends the summary to everyone whose chosen time has just come, once per local day.
export async function runSummaries(env, now, hasDevice, settingsOf) {
  const db = env.DB;
  const { results: rows } = await db.prepare(`SELECT user_id, key, value FROM user_settings WHERE key IN ('daily_summary', 'timezone')`).all();
  const people = new Map();
  for (const row of rows) {
    if (!hasDevice(row.user_id)) continue;
    if (!people.has(row.user_id)) people.set(row.user_id, { timezone: 'UTC' });
    people.get(row.user_id)[row.key] = parse(row.value);
  }
  const due = [];
  for (const [userId, p] of people) {
    const match = /^(\d\d):(\d\d)$/.exec(p.daily_summary ?? '');
    if (!match) continue;
    const at = Number(match[1]) * 60 + Number(match[2]);
    const clock = localClock(now, p.timezone || 'UTC');
    if (clock.minutes >= at && clock.minutes < at + SUMMARY_WINDOW_MIN) due.push({ userId, day: clock.day });
  }
  if (!due.length) return 0;

  const { results: done } = await db.prepare('SELECT user_id, day FROM summary_log WHERE sent_at > ?').bind(now - 2 * DAY).all();
  const sentDays = new Set(done.map((r) => `${r.user_id}|${r.day}`));
  let sent = 0;
  for (const { userId, day } of due) {
    if (sentDays.has(`${userId}|${day}`)) continue;
    // The insert doubles as a lock, so two overlapping runs can't both send it.
    const { meta } = await db.prepare('INSERT OR IGNORE INTO summary_log (user_id, day, sent_at) VALUES (?, ?, ?)').bind(userId, day, now).run();
    if (!meta.changes) continue;
    const settings = await settingsOf(userId);
    const { payload, empty } = await summaryFor(env, userId, now, settings);
    if (empty) continue;
    sent += (await sendToDevices(env, userId, payload, { ttl: 3 * HOUR / 1000 })).sent;
  }
  return sent;
}
