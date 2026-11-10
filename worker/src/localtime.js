// Local clock times in a person's time zone (the app sends the phone's zone, e.g. "Europe/Sofia").
import { MINUTE, HOUR } from './util.js';

const safeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
};

// "13:00"
export function formatTime(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: safeZone(timeZone) }).format(ms);
}

// The local date and time of day at an instant: { day: '2026-11-10', minutes: 450, ... }
export function localClock(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: safeZone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const [y, m, d, hour, minute] = [parts.year, parts.month, parts.day, parts.hour, parts.minute].map(Number);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: hour * 60 + minute, y, m, d, hour, minute };
}

// How far the zone's clock is ahead of UTC at an instant.
function offsetAt(ms, timeZone) {
  const c = localClock(ms, timeZone);
  return Date.UTC(c.y, c.m - 1, c.d, c.hour, c.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

// Local midnight of the given local date, as a timestamp (twice, to use the offset of midnight itself
// on days the clocks change).
function midnight(y, m, d, near, timeZone) {
  const wall = Date.UTC(y, m - 1, d);
  const guess = wall - offsetAt(near, timeZone);
  return wall - offsetAt(guess, timeZone);
}

// Start and end of the local day that contains the instant.
export function localDay(ms, timeZone) {
  const today = localClock(ms, timeZone);
  const start = midnight(today.y, today.m, today.d, ms, timeZone);
  const tomorrow = localClock(start + 26 * HOUR, timeZone);
  const end = midnight(tomorrow.y, tomorrow.m, tomorrow.d, start + 26 * HOUR, timeZone);
  return { start, end, day: today.day };
}
