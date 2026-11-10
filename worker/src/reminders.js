import { MINUTE, DAY } from './util.js';
import { getSettings } from './settings.js';
import { sendToDevices } from './push.js';
import { MAX_OFFSET_MIN } from './crud.js';
import { formatTime } from './localtime.js';
import { runSummaries, unmarkedCount } from './summary.js';

// A reminder may go out up to this long after its planned time (covers a late or skipped cron run).
// Older ones are skipped, so an item added at the last minute doesn't fire a burst of stale reminders.
export const GRACE_MS = 10 * MINUTE;

const TEXT = {
  en: {
    lesson: (until, time) => `Lesson in ${until} · ${time}`,
    lessonNow: (time) => `Lesson starting now · ${time}`,
    topic: 'Topic',
    now: 'Now',
    inTime: (until) => `In ${until}`,
    test: { title: 'Test notification 🔔', body: 'Reminders are working on this device.' },
    units: { min: 'min', h: 'h', hour: 'hour', hours: 'hours', day: 'day', days: 'days' },
  },
  bg: {
    lesson: (until, time) => `Урок след ${until} · ${time}`,
    lessonNow: (time) => `Урокът започва сега · ${time}`,
    topic: 'Тема',
    now: 'Сега',
    inTime: (until) => `След ${until}`,
    test: { title: 'Тестово известие 🔔', body: 'Напомнянията работят на това устройство.' },
    units: { min: 'мин', h: 'ч', hour: 'час', hours: 'часа', day: 'ден', days: 'дни' },
  },
};
const text = (lang) => TEXT[lang] ?? TEXT.en;

export const testMessage = (lang) => ({ ...text(lang).test, url: '#/settings', tag: 'test' });

// An item's own reminder times (minutes before its start), or the fallback.
export function offsetsOf(row, fallback) {
  if (row.remind_offsets) {
    try {
      const list = JSON.parse(row.remind_offsets);
      if (Array.isArray(list)) return list;
    } catch {
      // fall through to the fallback
    }
  }
  return fallback;
}

// Returns the offset (minutes before start) that is due right now, or null.
export function dueOffset(startAt, offsets, now, grace = GRACE_MS) {
  const due = offsets.filter((o) => {
    const at = startAt - o * MINUTE;
    return now >= at && now - at <= grace;
  });
  return due.length ? Math.min(...due) : null;
}

export function untilText(ms, lang = 'en') {
  const u = text(lang).units;
  const m = Math.max(1, Math.round(ms / MINUTE));
  if (m % 1440 === 0) return m === 1440 ? `1 ${u.day}` : `${m / 1440} ${u.days}`;
  if (m < 60) return `${m} ${u.min}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (rest) return `${h} ${u.h} ${rest} ${u.min}`;
  return h === 1 ? `1 ${u.hour}` : `${h} ${u.hours}`;
}

export function buildReminder(lesson, now, timeZone, lang = 'en') {
  const T = text(lang);
  const time = formatTime(lesson.start_at, timeZone);
  const left = lesson.start_at - now;
  const details = [lesson.subject, lesson.grade_level].filter(Boolean).join(', ');
  const lines = [`${lesson.name}${details ? ` — ${details}` : ''}`];
  if (lesson.topic) lines.push(`${T.topic}: ${lesson.topic}`);
  return {
    title: left < MINUTE ? T.lessonNow(time) : T.lesson(untilText(left, lang), time),
    body: lines.join('\n'),
    url: `#/lesson/${lesson.id}`,
    tag: `lesson-${lesson.id}`,
  };
}

export function buildEventReminder(event, now, timeZone, lang = 'en') {
  const T = text(lang);
  const left = event.start_at - now;
  const when = left < MINUTE ? T.now : T.inTime(untilText(left, lang));
  return {
    title: `${event.title} · ${formatTime(event.start_at, timeZone)}`,
    body: event.note ? `${when}\n${event.note.slice(0, 240)}` : when,
    url: `#/event/${event.id}`,
    tag: `event-${event.id}`,
  };
}

// The insert doubles as a lock: only the run that records a reminder sends it.
async function claim(env, itemId, startAt, offset, now) {
  const { meta } = await env.DB.prepare(
    'INSERT OR IGNORE INTO reminder_log (item_id, start_at, offset_min, sent_at) VALUES (?, ?, ?, ?)',
  )
    .bind(itemId, startAt, offset, now)
    .run();
  return meta.changes > 0;
}

export async function runReminders(env, now = Date.now()) {
  const report = { checked: 0, sent: 0 };
  // Anything starting within the next week (the longest reminder time) or just now.
  const from = now - GRACE_MS;
  const to = now + MAX_OFFSET_MIN * MINUTE;

  // Only users with at least one phone set up get reminders; each user has their own settings.
  const { results: withDevices } = await env.DB.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all();
  const users = new Set(withDevices.map((r) => r.user_id));
  const settingsCache = new Map();
  const settingsOf = async (userId) => {
    if (!settingsCache.has(userId)) settingsCache.set(userId, await getSettings(env, userId));
    return settingsCache.get(userId);
  };
  // Every notification also carries the number for the app icon (unless that is switched off).
  const badges = new Map();
  const badgeOf = async (userId) => {
    if (!(await settingsOf(userId)).app_badge) return undefined;
    if (!badges.has(userId)) badges.set(userId, await unmarkedCount(env, userId, now));
    return badges.get(userId);
  };

  if (users.size) {
    const { results: lessons } = await env.DB.prepare(
      `SELECT l.id, l.user_id, l.start_at, l.topic, l.remind_offsets, s.name, s.subject, s.grade_level
         FROM lessons l JOIN students s ON s.id = l.student_id
        WHERE l.status = 'scheduled' AND l.reminders_on = 1 AND l.start_at >= ? AND l.start_at <= ?`,
    )
      .bind(from, to)
      .all();
    const { results: events } = await env.DB.prepare(
      `SELECT id, user_id, title, note, start_at, remind_offsets FROM events
        WHERE status = 'scheduled' AND reminders_on = 1 AND start_at >= ? AND start_at <= ?`,
    )
      .bind(from, to)
      .all();
    report.checked = lessons.length + events.length;

    for (const lesson of lessons) {
      if (!users.has(lesson.user_id)) continue;
      const settings = await settingsOf(lesson.user_id);
      const offset = dueOffset(lesson.start_at, offsetsOf(lesson, settings.reminder_offsets), now);
      if (offset == null || !(await claim(env, lesson.id, lesson.start_at, offset, now))) continue;
      const ttl = Math.max(300, Math.floor((lesson.start_at + 30 * MINUTE - now) / 1000));
      const payload = { ...buildReminder(lesson, now, settings.timezone, settings.language), badge: await badgeOf(lesson.user_id) };
      report.sent += (await sendToDevices(env, lesson.user_id, payload, { ttl })).sent;
    }
    for (const event of events) {
      if (!users.has(event.user_id)) continue;
      const settings = await settingsOf(event.user_id);
      const offset = dueOffset(event.start_at, offsetsOf(event, [0]), now);
      if (offset == null || !(await claim(env, event.id, event.start_at, offset, now))) continue;
      const ttl = Math.max(300, Math.floor((event.start_at + 30 * MINUTE - now) / 1000));
      const payload = { ...buildEventReminder(event, now, settings.timezone, settings.language), badge: await badgeOf(event.user_id) };
      report.sent += (await sendToDevices(env, event.user_id, payload, { ttl })).sent;
    }
    report.summaries = await runSummaries(env, now, (userId) => users.has(userId), settingsOf);
  }

  if (new Date(now).getUTCMinutes() === 0) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reminder_log WHERE sent_at < ?').bind(now - 60 * DAY),
      env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(now - DAY),
      env.DB.prepare('DELETE FROM summary_log WHERE sent_at < ?').bind(now - 60 * DAY),
    ]);
  }
  return report;
}
