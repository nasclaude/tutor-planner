import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { state, student, lessonEnd, eventEnd, notifies } from '../store.js';
import { fmtTime, fmtWeekday, fmtDayMonth, startOfWeek, addDays, dateKey, fromKeys, sameDay, HOUR } from '../time.js';
import { pageHeader, fab, fmtMoney, firstName } from '../components.js';
import { addMenu } from '../actions.js';

const HOUR_PX = 64;
const GUTTER_PX = 36;
const LINE_PX = 13; // line height of the text inside a block
const MIN_BLOCK_PX = 58; // room for the time plus three lines of text, even for short items
const pad = (n) => String(n).padStart(2, '0');
const minutesInto = (ms, firstHour) => {
  const d = new Date(ms);
  return (d.getHours() - firstHour) * 60 + d.getMinutes();
};

// Where the day columns were scrolled to, so the live refresh doesn't jump back.
let remembered = { week: null, left: 0 };

const STACK_GAP_PX = 30; // a later item this far down still leaves the earlier one's time and title visible
const STACK_INDENT = 26; // % of the day's width

function blockText({ kind, item, narrow }) {
  if (kind === 'lesson') {
    const s = student(item.student_id);
    const name = s?.name ?? t('lesson.title');
    return { title: narrow ? firstName(name) : name, sub: item.topic || s?.subject || '' };
  }
  return { title: item.title, sub: (item.note ?? '').trim() };
}

// Places one group of items that overlap on screen. Normally the later item is indented and laid on
// top of the earlier one, like stacked cards, so both keep most of the width. Items that start almost
// together would hide each other that way, so those sit side by side instead.
function placeCluster(cluster) {
  const startsApart = cluster.every((e, i) =>
    cluster.slice(0, i).every((p) => p.shownEnd <= e.start || ((e.start - p.start) / HOUR) * HOUR_PX >= STACK_GAP_PX),
  );
  if (startsApart) {
    return cluster.map((e, i) => {
      const depth = Math.min(2, cluster.slice(0, i).filter((p) => p.shownEnd > e.start).length);
      return { ...e, left: depth * STACK_INDENT, width: 100 - depth * STACK_INDENT, z: i + 1, stacked: depth > 0, narrow: false };
    });
  }
  const laneEnds = [];
  const lanes = cluster.map((e) => {
    let lane = laneEnds.findIndex((end) => end <= e.start);
    if (lane === -1) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = e.shownEnd;
    return lane;
  });
  const count = laneEnds.length;
  return cluster.map((e, i) => ({ ...e, left: (lanes[i] * 100) / count, width: 100 / count, z: 1, stacked: false, narrow: count > 1 }));
}

// entries are sorted by start; items that don't overlap anything keep the full width.
function layoutDay(entries) {
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  for (const entry of entries) {
    if (cluster.length && entry.start >= clusterEnd) {
      out.push(...placeCluster(cluster));
      cluster = [];
    }
    clusterEnd = cluster.length ? Math.max(clusterEnd, entry.shownEnd) : entry.shownEnd;
    cluster.push(entry);
  }
  if (cluster.length) out.push(...placeCluster(cluster));
  return out;
}

// entries: [{ kind, item, start, end, shownEnd }] for one day, sorted by start.
function dayColumn(day, entries, firstHour, now) {
  const isToday = sameDay(day, now);
  const nowTop = (minutesInto(now, firstHour) / 60) * HOUR_PX;

  return html`
    <div class="week-col ${isToday ? 'today' : ''}" data-action="slot" data-day="${dateKey(day)}" data-first="${firstHour}">
      ${layoutDay(entries).map((entry) => {
        const { kind, item, start, end, left, width, z, stacked } = entry;
        const top = (minutesInto(start, firstHour) / 60) * HOUR_PX;
        const height = Math.max(((end - start) / HOUR) * HOUR_PX - 2, MIN_BLOCK_PX);
        const lines = Math.max(1, Math.floor((height - 6 - LINE_PX) / LINE_PX));
        const { title, sub } = blockText(entry);
        const href = kind === 'lesson' ? `#/lesson/${item.id}` : `#/event/${item.id}`;
        const look = `${kind === 'lesson' ? 'week-lesson' : 'week-event'} is-${item.status}`;
        const bell = notifies(item) && item.status === 'scheduled';
        return html`
          <button type="button" class="week-item ${look} ${stacked ? 'stacked' : ''}" data-action="open" data-href="${href}" data-lines="${lines}"
            style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);z-index:${z}"
            aria-label="${t('week.at', { name: title, time: fmtTime(start) })}">
            <span class="wl-time">${fmtTime(start)}${bell ? icon('bell') : ''}</span>
            <span class="wl-title" style="-webkit-line-clamp:${lines}">${title}</span>
            ${sub ? html`<span class="wl-sub" hidden>${sub}</span>` : ''}
          </button>`;
      })}
      ${isToday && nowTop >= 0 ? html`<div class="now-line" style="top:${nowTop}px"></div>` : ''}
    </div>`;
}

export default {
  tab: 'week',
  title: () => t('week.title'),
  live: true,
  render(ctx) {
    // When this screen redraws itself, keep the days where they were scrolled to;
    // coming here from another screen starts at today again.
    const live = document.querySelector('[data-week-scroll]');
    remembered = live ? { week: live.dataset.week, left: live.scrollLeft } : { week: null, left: 0 };

    const now = Date.now();
    const weekStart = startOfWeek(ctx.params.date ? fromKeys(ctx.params.date) : now);
    const weekEnd = addDays(weekStart, 7);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const lessons = state.lessons.filter((l) => l.start_at >= weekStart && l.start_at < weekEnd);
    const events = state.events.filter((e) => e.start_at >= weekStart && e.start_at < weekEnd);
    const minShown = (MIN_BLOCK_PX / HOUR_PX) * HOUR;
    const entries = [
      ...lessons.map((item) => ({ kind: 'lesson', item, start: item.start_at, end: lessonEnd(item) })),
      ...events.map((item) => ({ kind: 'event', item, start: item.start_at, end: eventEnd(item) })),
    ]
      .map((e) => ({ ...e, shownEnd: e.start + Math.max(e.end - e.start, minShown) }))
      .sort((a, b) => a.start - b.start);

    // Show 08:00–20:00, stretched to fit anything earlier or later.
    let first = 8;
    let last = 20;
    for (const { start, shownEnd } of entries) {
      const s = new Date(start);
      const e = new Date(shownEnd);
      first = Math.min(first, s.getHours());
      last = Math.max(last, sameDay(s, e) ? e.getHours() + (e.getMinutes() ? 1 : 0) : 24);
    }
    const hours = Array.from({ length: last - first }, (_, i) => first + i);

    const planned = lessons.filter((l) => l.status === 'scheduled').length;
    const done = lessons.filter((l) => l.status === 'completed');
    const earned = done.reduce((sum, l) => sum + (l.price || 0), 0);
    const summary = [t('week.summary', { planned, done: done.length })];
    if (events.length) summary.push(tn('n.reminders', events.length));
    if (earned) summary.push(t('week.earned', { amount: fmtMoney(earned) }));
    const isThisWeek = now >= weekStart && now < weekEnd;

    return html`
      ${pageHeader({
        title: t('week.title'),
        subtitle: `${fmtDayMonth(weekStart)} – ${fmtDayMonth(addDays(weekStart, 6))}`,
        right: html`
          <a class="icon-btn" href="#/week/${dateKey(addDays(weekStart, -7))}" aria-label="${t('week.prev')}">${icon('chevronLeft')}</a>
          ${isThisWeek ? '' : html`<a class="btn small" href="#/week">${t('week.thisWeek')}</a>`}
          <a class="icon-btn" href="#/week/${dateKey(addDays(weekStart, 7))}" aria-label="${t('week.next')}">${icon('chevronRight')}</a>`,
      })}
      <div class="card week">
        <div class="week-scroll" data-week-scroll data-week="${dateKey(weekStart)}">
          <div class="week-grid">
            <div class="week-head">
              <div class="week-corner"></div>
              ${days.map(
                (d) => html`<div class="week-day ${sameDay(d, now) ? 'today' : ''}"><span>${fmtWeekday(d)}</span><strong>${new Date(d).getDate()}</strong></div>`,
              )}
            </div>
            <div class="week-body" style="height:${hours.length * HOUR_PX}px;--hour:${HOUR_PX}px" data-hour-px="${HOUR_PX}">
              <div class="week-hours">${hours.map((h) => html`<div class="week-hour" style="top:${(h - first) * HOUR_PX}px">${pad(h)}</div>`)}</div>
              ${days.map((d) => dayColumn(d, entries.filter((e) => sameDay(e.start, d)), first, now))}
            </div>
          </div>
        </div>
      </div>
      <p class="week-summary">${summary.join(' · ')}</p>
      <p class="muted small center">${t('week.hint')}</p>
      ${fab(null, t('add.aria'), { chooser: true })}`;
  },
  mounted(root) {
    // Under the title, show as much of the topic / note as fits in the block.
    for (const block of root.querySelectorAll('.week-item')) {
      const sub = block.querySelector('.wl-sub');
      if (!sub) continue;
      const used = Math.max(1, Math.round(block.querySelector('.wl-title').getBoundingClientRect().height / LINE_PX));
      const left = Number(block.dataset.lines) - used;
      if (left >= 1) {
        sub.hidden = false;
        sub.style.webkitLineClamp = String(left);
      }
    }

    // On a phone the days scroll sideways: start at today, or where you left off.
    const scroller = root.querySelector('[data-week-scroll]');
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return;
    if (remembered.week === scroller.dataset.week) {
      scroller.scrollLeft = remembered.left;
    } else {
      const today = root.querySelector('.week-day.today');
      if (today) scroller.scrollLeft = today.getBoundingClientRect().left - scroller.getBoundingClientRect().left - GUTTER_PX;
      remembered = { week: scroller.dataset.week, left: scroller.scrollLeft };
    }
    scroller.addEventListener('scroll', () => (remembered = { week: scroller.dataset.week, left: scroller.scrollLeft }), { passive: true });
  },
  actions: {
    slot(el, ctx, ev) {
      const rect = el.getBoundingClientRect();
      const halfHours = Math.max(0, Math.floor(((ev.clientY - rect.top) / HOUR_PX) * 2));
      const total = Number(el.dataset.first) * 60 + halfHours * 30;
      addMenu(fromKeys(el.dataset.day, `${pad(Math.min(23, Math.floor(total / 60)))}:${pad(total % 60)}`));
    },
    open(el) {
      location.hash = el.dataset.href;
    },
  },
};
