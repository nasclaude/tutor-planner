// Date helpers. Everything is in the device's local time; times are shown in 24-hour format.
import { t, tn, names, getLang } from './i18n.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const pad = (n) => String(n).padStart(2, '0');

export function dateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function timeKey(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const monthKey = (ms) => dateKey(ms).slice(0, 7);

export function fromKeys(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Same wall-clock time n days later (safe across daylight-saving changes).
export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function startOfWeek(ms) {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start on Monday
  return d.getTime();
}

export function startOfMonth(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function addMonths(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}

// Same date and time n months later; the 31st becomes the last day of a shorter month.
export function addMonthsSameDate(ms, n) {
  const d = new Date(ms);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), lastDay), d.getHours(), d.getMinutes()).getTime();
}

// Start times of a repeating series: every 'week', '2weeks' or 'month', for the given number of months.
export function repeatStarts(start, every, months) {
  if (every === 'month') return Array.from({ length: months }, (_, i) => addMonthsSameDate(start, i));
  const step = every === '2weeks' ? 14 : 7;
  const until = addMonthsSameDate(start, months);
  const out = [];
  for (let i = 0; addDays(start, i * step) < until; i++) out.push(addDays(start, i * step));
  return out;
}

export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
export const sameDay = (a, b) => dateKey(a) === dateKey(b);

const bg = () => getLang() === 'bg';

export const fmtTime = timeKey; // 13:00
export const fmtWeekday = (ms) => names().weekdaysShort[new Date(ms).getDay()]; // Sun / нд
export const fmtDayMonth = (ms) => `${new Date(ms).getDate()} ${names().monthsShort[new Date(ms).getMonth()]}`; // 8 Nov

// Sun 8 Nov / нд, 8 ное
export function fmtDay(ms) {
  return `${fmtWeekday(ms)}${bg() ? ',' : ''} ${fmtDayMonth(ms)}`;
}

// Sunday 8 November / неделя, 8 ноември
export function fmtDayLong(ms) {
  const d = new Date(ms);
  const n = names();
  return `${n.weekdaysLong[d.getDay()]}${bg() ? ',' : ''} ${d.getDate()} ${n.monthsLong[d.getMonth()]}`;
}

export const fmtWeekdayLong = (ms) => names().weekdaysLong[new Date(ms).getDay()]; // Tuesday / вторник

// November 2026 / ноември 2026
export const fmtMonth = (ms) => `${names().monthsLong[new Date(ms).getMonth()]} ${new Date(ms).getFullYear()}`;

// "Today" / "Tomorrow" / "Sun 8 Nov". With mid: true, the form used inside a sentence ("moved to tomorrow").
export function dayLabel(ms, now = Date.now(), { mid = false } = {}) {
  const diff = daysBetween(now, ms);
  const suffix = mid ? 'Mid' : '';
  if (diff === 0) return t(`time.today${suffix}`);
  if (diff === 1) return t(`time.tomorrow${suffix}`);
  if (diff === -1) return t(`time.yesterday${suffix}`);
  return fmtDay(ms);
}

// "tomorrow at 15:00" / "утре в 15:00"
export const fmtWhen = (ms, now = Date.now()) => t('time.dayAt', { day: dayLabel(ms, now, { mid: true }), time: fmtTime(ms) });

export function fmtMinutes(min) {
  if (min < 60) return t('time.min', { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t('time.hmin', { h, m }) : t('time.h', { n: h });
}

// "in 2 h 15 min", "in 5 h", "in 3 days", "20 min ago"
export function fmtRelative(ms, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return t('time.now');
  let text;
  if (abs < 3 * HOUR) text = fmtMinutes(Math.round(abs / MINUTE));
  else if (abs < DAY) text = t('time.h', { n: Math.round(abs / HOUR) });
  else text = tn('time.days', Math.round(abs / DAY));
  return t(diff > 0 ? 'time.in' : 'time.ago', { t: text });
}

// Reminder offsets: 1440 -> "1 day", 180 -> "3 h", 30 -> "30 min"
export function fmtOffset(min) {
  if (min % 1440 === 0) return tn('time.days', min / 1440);
  return fmtMinutes(min);
}
