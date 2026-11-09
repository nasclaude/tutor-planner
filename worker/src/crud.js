// Reading and writing the user's own data. Every query is limited to the logged-in user's rows, so
// nobody can read, change or point to anyone else's students, lessons or reminders.
import { HttpError } from './util.js';
import { getSettings } from './settings.js';

// Reminder times for one lesson or event: minutes before the start (0 = at the start).
export const MAX_OFFSET_MIN = 10080;
const MAX_OFFSETS = 9;

// Which fields the app may write, per table. id, user_id, series_id and the timestamps are set here.
export const SCHEMA = {
  students: {
    name: { type: 'text', required: true, max: 120 },
    subject: { type: 'text', max: 120 },
    grade_level: { type: 'text', max: 60 },
    school: { type: 'text', max: 120 },
    phone: { type: 'text', max: 40 },
    parent_name: { type: 'text', max: 120 },
    parent_phone: { type: 'text', max: 40 },
    price: { type: 'money' },
    notes: { type: 'text', max: 5000 },
    archived: { type: 'bool' },
  },
  lessons: {
    student_id: { type: 'ref', table: 'students', required: true },
    start_at: { type: 'int', required: true, min: 0 },
    duration_min: { type: 'int', notNull: true, min: 5, max: 600 },
    topic: { type: 'text', max: 200 },
    status: { type: 'enum', values: ['scheduled', 'completed', 'cancelled'] },
    reminders_on: { type: 'bool' },
    remind_offsets: { type: 'offsets' },
    notes: { type: 'text', max: 5000 },
    price: { type: 'money' },
    paid: { type: 'bool' },
  },
  grades: {
    student_id: { type: 'ref', table: 'students', required: true },
    date: { type: 'date', required: true },
    value: { type: 'text', required: true, max: 20 },
    title: { type: 'text', max: 200 },
    note: { type: 'text', max: 2000 },
  },
  homework: {
    student_id: { type: 'ref', table: 'students', required: true },
    lesson_id: { type: 'ref', table: 'lessons' },
    text: { type: 'text', required: true, max: 2000 },
    status: { type: 'enum', values: ['open', 'done', 'missed'] },
    due_date: { type: 'date' },
  },
  events: {
    title: { type: 'text', required: true, max: 200 },
    note: { type: 'text', max: 5000 },
    start_at: { type: 'int', required: true, min: 0 },
    duration_min: { type: 'int', min: 5, max: 1440 },
    reminders_on: { type: 'bool' },
    remind_offsets: { type: 'offsets' },
    status: { type: 'enum', values: ['scheduled', 'completed', 'cancelled'] },
  },
};

const LABELS = { student_id: 'Student', start_at: 'Start time', duration_min: 'Lesson length', lesson_id: 'Lesson', due_date: 'Due date' };
const label = (field) => LABELS[field] ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, ' ');

// ctx: { userId, cache } — cache holds lookups shared within one request (a series checks its student once).
async function coerce(env, field, def, v, ctx) {
  const bad = (why) => new HttpError(400, `${label(field)} ${why}`, 'invalid');
  switch (def.type) {
    case 'text': {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      if (s.length > def.max) throw bad('is too long');
      return s;
    }
    case 'int': {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw bad('must be a whole number');
      if ((def.min != null && n < def.min) || (def.max != null && n > def.max)) throw bad('is out of range');
      return n;
    }
    case 'money': {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1e7) throw bad('must be a positive number');
      return Math.round(n * 100) / 100;
    }
    case 'bool':
      return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    case 'offsets': {
      if (v == null || v === '') return null;
      const list = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map(Number))].sort((a, b) => b - a);
      if (list.length > MAX_OFFSETS || list.some((n) => !Number.isInteger(n) || n < 0 || n > MAX_OFFSET_MIN)) {
        throw bad(`must be up to ${MAX_OFFSETS} times between 0 minutes and 7 days`);
      }
      return JSON.stringify(list);
    }
    case 'enum':
      if (!def.values.includes(v)) throw bad(`must be one of: ${def.values.join(', ')}`);
      return v;
    case 'date':
      if (v == null || v === '') return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('must be a date (YYYY-MM-DD)');
      return v;
    case 'ref': {
      if (v == null || v === '') return null;
      // Only your own students / lessons can be referred to.
      const key = `${def.table}:${v}`;
      if (!ctx.cache.has(key)) {
        const found = typeof v === 'string' && !!(await env.DB.prepare(`SELECT 1 AS x FROM ${def.table} WHERE id = ? AND user_id = ?`).bind(v, ctx.userId).first());
        ctx.cache.set(key, found);
      }
      // Its own code: the app then reloads its data (the item was probably deleted elsewhere).
      if (!ctx.cache.get(key)) throw new HttpError(400, `${label(field)} was not found`, 'ref_not_found');
      return v;
    }
    default:
      throw new Error(`Unknown field type ${def.type}`);
  }
}

async function clean(env, table, input, { partial, userId, cache = new Map() }) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Expected an object', 'invalid');
  const out = {};
  for (const [field, def] of Object.entries(SCHEMA[table])) {
    if (!(field in input)) {
      if (!partial && def.required) throw new HttpError(400, `${label(field)} is required`, 'invalid');
      continue;
    }
    const value = await coerce(env, field, def, input[field], { userId, cache });
    if (value == null && (def.required || def.notNull)) throw new HttpError(400, `${label(field)} is required`, 'invalid');
    out[field] = value;
  }
  return out;
}

export function getRow(env, table, id, userId) {
  return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).first();
}

export async function listAll(env, userId) {
  const db = env.DB;
  const [students, lessons, grades, homework, events] = await db.batch([
    db.prepare('SELECT * FROM students WHERE user_id = ? ORDER BY name COLLATE NOCASE').bind(userId),
    db.prepare('SELECT * FROM lessons WHERE user_id = ? ORDER BY start_at').bind(userId),
    db.prepare('SELECT * FROM grades WHERE user_id = ? ORDER BY date DESC, created_at DESC').bind(userId),
    db.prepare('SELECT * FROM homework WHERE user_id = ? ORDER BY created_at DESC').bind(userId),
    db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY start_at').bind(userId),
  ]);
  return {
    students: students.results,
    lessons: lessons.results,
    grades: grades.results,
    homework: homework.results,
    events: events.results,
  };
}

// Validates one new item and fills in the server-side fields (not yet saved).
async function buildRow(env, table, input, now, userId, cache) {
  const data = await clean(env, table, input, { partial: false, userId, cache });
  for (const key of Object.keys(data)) if (data[key] == null) delete data[key]; // let column defaults apply
  const row = { id: crypto.randomUUID(), user_id: userId, ...data, created_at: now, updated_at: now };
  // Each item keeps its own reminder times. New lessons start with the default from the user's
  // settings, planner reminders with "at the time".
  if (table === 'lessons' && row.remind_offsets === undefined) {
    if (!cache.has('settings')) cache.set('settings', await getSettings(env, userId));
    row.remind_offsets = JSON.stringify(cache.get('settings').reminder_offsets);
  }
  if (table === 'events' && row.remind_offsets === undefined) row.remind_offsets = '[0]';
  if (table === 'lessons' && row.paid) row.paid_at = now;
  if (table === 'homework' && row.status && row.status !== 'open') row.checked_at = now;
  return row;
}

// INSERT statements for rows of the same table, several rows per statement. D1 allows at most
// 100 bound values per query and (on the free plan) 50 queries per request, so a year of weekly
// lessons still fits comfortably.
function insertStatements(env, table, rows) {
  const groups = new Map();
  for (const row of rows) {
    const cols = Object.keys(row).join(',');
    if (!groups.has(cols)) groups.set(cols, []);
    groups.get(cols).push(row);
  }
  const stmts = [];
  for (const [colList, group] of groups) {
    const cols = colList.split(',');
    const perStatement = Math.max(1, Math.floor(100 / cols.length));
    for (let i = 0; i < group.length; i += perStatement) {
      const chunk = group.slice(i, i + perStatement);
      const placeholders = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
      stmts.push(
        env.DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}`).bind(...chunk.flatMap((row) => cols.map((c) => row[c]))),
      );
    }
  }
  return stmts;
}

export async function createRow(env, table, input, userId) {
  const row = await buildRow(env, table, input, Date.now(), userId, new Map());
  await env.DB.batch(insertStatements(env, table, [row]));
  return getRow(env, table, row.id, userId);
}

export const MAX_SERIES = 60;

// A repeating series (e.g. every Tuesday for 3 months): every item is a normal, separate row that
// can be edited on its own; they only share a series_id. Nothing is saved unless all items are valid.
export async function createSeries(env, table, items, userId) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_SERIES) {
    throw new HttpError(400, `Send between 1 and ${MAX_SERIES} items`, 'invalid');
  }
  const now = Date.now();
  const cache = new Map();
  const seriesId = crypto.randomUUID();
  const rows = [];
  for (const input of items) rows.push({ ...(await buildRow(env, table, input, now, userId, cache)), series_id: seriesId });
  await env.DB.batch(insertStatements(env, table, rows));
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE series_id = ? AND user_id = ? ORDER BY start_at`).bind(seriesId, userId).all();
  return results;
}

export async function updateRow(env, table, id, input, userId) {
  const existing = await getRow(env, table, id, userId);
  if (!existing) throw new HttpError(404, 'Not found', 'not_found');
  const data = await clean(env, table, input, { partial: true, userId });
  const now = Date.now();

  if (table === 'lessons' && 'paid' in data && data.paid !== existing.paid) data.paid_at = data.paid ? now : null;
  if (table === 'homework' && 'status' in data && data.status !== existing.status) {
    data.checked_at = data.status === 'open' ? null : now;
  }
  if (!Object.keys(data).length) return existing;

  data.updated_at = now;
  const cols = Object.keys(data);
  await env.DB.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...cols.map((c) => data[c]), id, userId)
    .run();
  return getRow(env, table, id, userId);
}

// Deletes one row, or with `following` a lesson/reminder and every later one in its series.
// Returns the ids that were deleted.
export async function deleteRow(env, table, id, userId, { following = false } = {}) {
  const row = await getRow(env, table, id, userId);
  if (!row) throw new HttpError(404, 'Not found', 'not_found');
  const db = env.DB;

  if (following && row.series_id && (table === 'lessons' || table === 'events')) {
    const which = `SELECT id FROM ${table} WHERE series_id = ? AND user_id = ? AND start_at >= ?`;
    const args = [row.series_id, userId, row.start_at];
    const { results } = await db.prepare(which).bind(...args).all();
    const stmts = [db.prepare(`DELETE FROM reminder_log WHERE item_id IN (${which})`).bind(...args)];
    if (table === 'lessons') stmts.push(db.prepare(`UPDATE homework SET lesson_id = NULL WHERE lesson_id IN (${which})`).bind(...args));
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE series_id = ? AND user_id = ? AND start_at >= ?`).bind(...args));
    await db.batch(stmts);
    return results.map((r) => r.id);
  }

  const stmts = [];
  if (table === 'students') {
    stmts.push(
      db.prepare('DELETE FROM reminder_log WHERE item_id IN (SELECT id FROM lessons WHERE student_id = ? AND user_id = ?)').bind(id, userId),
      db.prepare('DELETE FROM homework WHERE student_id = ? AND user_id = ?').bind(id, userId),
      db.prepare('DELETE FROM grades WHERE student_id = ? AND user_id = ?').bind(id, userId),
      db.prepare('DELETE FROM lessons WHERE student_id = ? AND user_id = ?').bind(id, userId),
    );
  } else if (table === 'lessons') {
    stmts.push(
      db.prepare('DELETE FROM reminder_log WHERE item_id = ?').bind(id),
      db.prepare('UPDATE homework SET lesson_id = NULL WHERE lesson_id = ? AND user_id = ?').bind(id, userId),
    );
  } else if (table === 'events') {
    stmts.push(db.prepare('DELETE FROM reminder_log WHERE item_id = ?').bind(id));
  }
  stmts.push(db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId));
  await db.batch(stmts);
  return [id];
}
