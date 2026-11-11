// App state: everything is loaded once from the API, kept in memory, and cached for offline use.
import { api } from './api.js';
import { MINUTE } from './time.js';

const CACHE_KEY = 'tp.cache.v1';

export const DEFAULT_SETTINGS = {
  reminder_offsets: [180, 120, 60],
  currency: '€',
  default_duration: 60,
  language: 'en',
  timezone: 'UTC',
  daily_summary: '', // morning summary time ("07:30"), "" = off
  app_badge: true, // number on the app icon: past lessons still to mark
};

const empty = () => ({
  loaded: false,
  offline: false,
  error: null,
  students: [],
  lessons: [],
  grades: [],
  homework: [],
  events: [],
  settings: { ...DEFAULT_SETTINGS },
  vapidPublicKey: null,
  devices: 0,
  photoCounts: {}, // lesson id -> number of photos
  me: null, // { id, name, username, is_admin, must_change_password }
  needsSetup: false, // no owner account yet: show the first-time setup screen
});

export const state = empty();

function apply(data) {
  state.students = data.students ?? [];
  state.lessons = data.lessons ?? [];
  state.grades = data.grades ?? [];
  state.homework = data.homework ?? [];
  state.events = data.events ?? [];
  state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  state.vapidPublicKey = data.vapidPublicKey ?? null;
  state.devices = data.devices ?? 0;
  state.photoCounts = data.photoCounts ?? {};
  state.me = data.me ?? null;
  state.loaded = true;
}

function persist() {
  try {
    const { students, lessons, grades, homework, events, settings, vapidPublicKey, devices, photoCounts, me } = state;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ students, lessons, grades, homework, events, settings, vapidPublicKey, devices, photoCounts, me }));
  } catch {
    // storage full or unavailable: the app still works online
  }
}

export function loadCached() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return false;
    apply(JSON.parse(cached));
    return true;
  } catch {
    return false;
  }
}

export async function loadData() {
  apply(await api('GET', '/api/data'));
  state.offline = false;
  state.error = null;
  persist();
}

export function resetState() {
  Object.assign(state, empty());
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

const SORTERS = {
  students: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  lessons: (a, b) => a.start_at - b.start_at,
  grades: (a, b) => b.date.localeCompare(a.date) || b.created_at - a.created_at,
  homework: (a, b) => b.created_at - a.created_at,
  events: (a, b) => a.start_at - b.start_at,
};

export async function createRow(table, data) {
  const row = await api('POST', `/api/${table}`, data);
  state[table].push(row);
  state[table].sort(SORTERS[table]);
  persist();
  return row;
}

export async function updateRow(table, id, patch) {
  const row = await api('PATCH', `/api/${table}/${id}`, patch);
  const i = state[table].findIndex((r) => r.id === id);
  if (i >= 0) state[table][i] = row;
  else state[table].push(row);
  state[table].sort(SORTERS[table]);
  persist();
  return row;
}

// A repeating series: separate lessons or reminders created in one go.
export async function createSeries(table, items) {
  const { rows } = await api('POST', `/api/${table}/bulk`, { items });
  state[table].push(...rows);
  state[table].sort(SORTERS[table]);
  persist();
  return rows;
}

// following: also delete the later items of the same series. Returns how many were deleted.
export async function deleteRow(table, id, { following = false } = {}) {
  const { deleted = [id] } = await api('DELETE', `/api/${table}/${id}${following ? '?following=1' : ''}`);
  const gone = new Set(deleted);
  state[table] = state[table].filter((r) => !gone.has(r.id));
  if (table === 'students') {
    for (const t of ['lessons', 'grades', 'homework']) state[t] = state[t].filter((r) => r.student_id !== id);
  }
  if (table === 'lessons') {
    for (const h of state.homework) if (gone.has(h.lesson_id)) h.lesson_id = null;
  }
  persist();
  return deleted.length;
}

// The item and the later items of its series (just the item when it isn't part of one).
export const seriesFrom = (table, item) =>
  item.series_id ? state[table].filter((r) => r.series_id === item.series_id && r.start_at >= item.start_at) : [item];

export async function saveSettings(patch) {
  state.settings = { ...DEFAULT_SETTINGS, ...(await api('PUT', '/api/settings', patch)) };
  persist();
}

// --- lookups ---

export const student = (id) => state.students.find((s) => s.id === id);
export const lesson = (id) => state.lessons.find((l) => l.id === id);
export const event = (id) => state.events.find((e) => e.id === id);
export const lessonEnd = (l) => l.start_at + l.duration_min * MINUTE;
// Planner reminders without a length are drawn as 30 minutes in the calendar.
export const eventEnd = (e) => e.start_at + (e.duration_min || 30) * MINUTE;

// Lessons and planner reminders together, in time order: [{ kind: 'lesson' | 'event', item }]
export function agenda(from, to, { lessons = () => true, events = () => true } = {}) {
  return [
    ...state.lessons.filter((l) => l.start_at >= from && l.start_at < to && lessons(l)).map((item) => ({ kind: 'lesson', item })),
    ...state.events.filter((e) => e.start_at >= from && e.start_at < to && events(e)).map((item) => ({ kind: 'event', item })),
  ].sort((a, b) => a.item.start_at - b.item.start_at);
}

// The next lesson that hasn't finished yet (includes one in progress).
export function nextLesson(studentId = null, now = Date.now()) {
  return state.lessons.find((l) => l.status === 'scheduled' && lessonEnd(l) > now && (!studentId || l.student_id === studentId));
}

export function findOverlap(start, durationMin, excludeId = null) {
  const end = start + durationMin * MINUTE;
  return state.lessons.find((l) => l.id !== excludeId && l.status === 'scheduled' && l.start_at < end && lessonEnd(l) > start);
}

// Past lessons never marked done or cancelled ("Did it happen?" on Today, the number on the app icon).
export const needsMarking = (now = Date.now()) => state.lessons.filter((l) => l.status === 'scheduled' && lessonEnd(l) <= now);

export function unpaidLessons(studentId = null) {
  return state.lessons.filter(
    (l) => l.status === 'completed' && !l.paid && l.price > 0 && (!studentId || l.student_id === studentId),
  );
}

export const owed = (studentId) => unpaidLessons(studentId).reduce((sum, l) => sum + l.price, 0);

// What all of one student's lessons are worth, and how much of it is paid. Every lesson counts
// (done or still to come) except cancelled ones; a cancelled lesson that was paid anyway still
// counts, since that money was received.
export function studentMoney(studentId) {
  const counted = state.lessons.filter((l) => l.student_id === studentId && (l.status !== 'cancelled' || l.paid));
  const sum = (list) => list.reduce((total, l) => total + (l.price || 0), 0);
  return {
    lessons: counted.length,
    total: sum(counted),
    paid: sum(counted.filter((l) => l.paid)),
    noPrice: counted.filter((l) => l.price == null).length,
  };
}

// A lesson's or planner reminder's own reminder times (minutes before its start; 0 = at the start).
export function offsetsOf(item) {
  if (item.remind_offsets) {
    try {
      const list = JSON.parse(item.remind_offsets);
      if (Array.isArray(list)) return list;
    } catch {
      // fall back below
    }
  }
  return 'student_id' in item ? state.settings.reminder_offsets : [0];
}

export const notifies = (item) => !!item.reminders_on && offsetsOf(item).length > 0;

export const reminderTimes = (item) => offsetsOf(item).map((o) => item.start_at - o * MINUTE).sort((a, b) => a - b);
