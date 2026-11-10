import { HttpError } from './util.js';

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Each user has their own settings.
export const SETTINGS = {
  // Default reminder times for new lessons (minutes before). Default: 3 h, 2 h and 1 h before.
  reminder_offsets: {
    default: [180, 120, 60],
    parse(v) {
      if (!Array.isArray(v)) throw new HttpError(400, 'reminder_offsets must be a list');
      const list = [...new Set(v.map(Number))].sort((a, b) => b - a);
      if (list.length > 6 || list.some((n) => !Number.isInteger(n) || n < 1 || n > 10080)) {
        throw new HttpError(400, 'Reminder times must be between 1 minute and 7 days (max 6)');
      }
      return list;
    },
  },
  currency: {
    default: '€',
    parse(v) {
      const s = String(v ?? '').trim();
      if (s.length > 8) throw new HttpError(400, 'Currency is too long');
      return s;
    },
  },
  default_duration: {
    default: 60,
    parse(v) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 5 || n > 600) throw new HttpError(400, 'Lesson length must be 5–600 minutes');
      return n;
    },
  },
  // Language of the app and of the notification texts.
  language: {
    default: 'en',
    parse(v) {
      if (!['en', 'bg'].includes(v)) throw new HttpError(400, 'Language must be "en" or "bg"');
      return v;
    },
  },
  // Morning summary: the local time ("07:30") for one notification with the day's plan, or "" for off.
  daily_summary: {
    default: '',
    parse(v) {
      const s = String(v ?? '').trim();
      if (s && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, 'The summary time must look like 07:30');
      return s;
    },
  },
  // Show on the app icon how many past lessons are still waiting to be marked done or cancelled.
  app_badge: {
    default: true,
    parse(v) {
      if (typeof v !== 'boolean') throw new HttpError(400, 'app_badge must be true or false');
      return v;
    },
  },
  // Used to show local times in notifications. The app sends the phone's time zone.
  timezone: {
    default: 'UTC',
    parse(v) {
      if (typeof v !== 'string' || !validTimezone(v)) throw new HttpError(400, 'Unknown time zone');
      return v;
    },
  },
};

export async function getSettings(env, userId) {
  const { results } = await env.DB.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').bind(userId).all();
  const out = {};
  for (const [key, def] of Object.entries(SETTINGS)) out[key] = def.default;
  for (const row of results) {
    if (!(row.key in SETTINGS)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // ignore a corrupt value and keep the default
    }
  }
  return out;
}

export async function updateSettings(env, userId, patch) {
  const stmts = [];
  for (const [key, value] of Object.entries(patch)) {
    const def = SETTINGS[key];
    if (!def) continue;
    stmts.push(
      env.DB.prepare(
        'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
      ).bind(userId, key, JSON.stringify(def.parse(value))),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getSettings(env, userId);
}
