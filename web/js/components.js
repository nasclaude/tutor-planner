// Small reusable pieces of markup.
import { html } from './html.js';
import { icon } from './icons.js';
import { t, tn } from './i18n.js';
import { state, student, notifies, reminderTimes } from './store.js';
import { fmtTime, fmtMinutes, fmtDayMonth, fmtDay, fmtOffset, fromKeys, sameDay, dayLabel } from './time.js';

export const APP_VERSION = '1.2.0';

const PREFIX_CURRENCIES = ['$', '£', '€', '¥', '₹'];

export function fmtMoney(amount, currency = state.settings.currency) {
  if (amount == null || Number.isNaN(amount)) return '—';
  const n = Math.round(amount * 100) / 100;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  if (!currency) return text;
  return PREFIX_CURRENCIES.includes(currency) ? `${currency}${text}` : `${text} ${currency}`;
}

export const firstName = (name = '') => name.trim().split(/\s+/)[0] || name;
export const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

function hue(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

export function avatar(s, size = '') {
  const name = s?.name ?? '?';
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?';
  return html`<span class="avatar ${size}" style="--h:${hue(name)}" aria-hidden="true">${initials}</span>`;
}

// With `back`, the actions sit next to the Back button; otherwise next to the title.
export function pageHeader({ title, subtitle, back, right }) {
  const actions = right ? html`<div class="page-head-actions">${right}</div>` : '';
  const hasRow = title || subtitle || (!back && right);
  return html`
    <header class="page-head">
      ${back
        ? html`<div class="page-head-bar">
            <button type="button" class="back-btn" data-action="back" data-fallback="${back}">${icon('chevronLeft')}<span>${t('common.back')}</span></button>
            ${actions}
          </div>`
        : ''}
      ${hasRow
        ? html`<div class="page-head-row">
            <div class="page-head-text">
              ${title ? html`<h1>${title}</h1>` : ''}
              ${subtitle ? html`<p class="subtitle">${subtitle}</p>` : ''}
            </div>
            ${back ? '' : actions}
          </div>`
        : ''}
    </header>`;
}

export function emptyState({ icon: name, title, text, action }) {
  return html`
    <div class="empty">
      <div class="empty-icon">${icon(name)}</div>
      <h2>${title}</h2>
      ${text ? html`<p>${text}</p>` : ''}
      ${action ?? ''}
    </div>`;
}

export function notFound(what, back) {
  return html`${pageHeader({ back })}${emptyState({ icon: 'alert', title: what, text: t('common.maybeDeleted') })}`;
}

// The round "+" button. With `chooser`, it asks whether to add a lesson or a reminder.
export function fab(href, label, { chooser = false } = {}) {
  return chooser
    ? html`<button type="button" class="fab" data-action="add-menu" aria-label="${label}">${icon('plus')}</button>`
    : html`<a class="fab" href="${href}" aria-label="${label}">${icon('plus')}</a>`;
}

export function field(label, control, optional = false) {
  return html`<label class="field"><span>${label}${optional ? html` <em>${t('common.optional')}</em>` : ''}</span>${control}</label>`;
}

export function stat(label, value, note, tone = '') {
  return html`
    <div class="stat ${tone}">
      <span class="stat-label">${label}</span>
      <strong class="stat-value">${value}</strong>
      ${note ? html`<span class="stat-note">${note}</span>` : ''}
    </div>`;
}

// check: the row has a tick circle, so a "Done" badge would repeat it.
export function lessonBadges(l, { check = false } = {}) {
  const out = [];
  if (l.status === 'completed' && !check) out.push(html`<span class="badge success">${t('badge.done')}</span>`);
  if (l.status === 'cancelled') out.push(html`<span class="badge muted">${t('badge.cancelled')}</span>`);
  if (l.status === 'completed' && l.price > 0 && !l.paid) out.push(html`<span class="badge warn">${t('badge.unpaid')}</span>`);
  return out;
}

// A camera and the number of photos, on lessons that have some.
function photoMark(l) {
  const n = state.photoCounts?.[l.id];
  return n ? html`<span class="badge photo-badge" title="${tn('photos.count', n)}" aria-label="${tn('photos.count', n)}">${icon('camera')}${n}</span>` : '';
}

// Under the time in a row: a bell when notifications are on, and the length if there is one.
function rowMeta(item, minutes) {
  const bell = notifies(item) && item.status === 'scheduled';
  if (!bell && !minutes) return '';
  return html`<span class="row-meta">${bell ? icon('bell') : ''}${minutes ? fmtMinutes(minutes) : ''}</span>`;
}

// One lesson in a list. date: show the date column; showStudent: title is the student's name;
// check: add a tick circle that marks the lesson completed (or back to scheduled).
export function lessonRow(l, { date = false, showStudent = true, check = false } = {}) {
  const s = student(l.student_id);
  const href = `#/lesson/${l.id}`;
  const title = showStudent ? s?.name ?? t('common.unknownStudent') : l.topic || s?.subject || t('lesson.title');
  const sub = showStudent ? [s?.subject, l.topic].filter(Boolean).join(' · ') : fmtDay(l.start_at);
  const time = html`
    ${date ? html`<span class="row-date">${fmtDayMonth(l.start_at)}</span>` : ''}
    <strong>${fmtTime(l.start_at)}</strong>
    ${rowMeta(l, date ? null : l.duration_min)}`;
  const main = html`
    <div class="row-title"><span class="kind-dot lesson" aria-hidden="true"></span>${title}</div>
    ${sub ? html`<div class="row-sub">${sub}</div>` : ''}`;

  if (!check) {
    return html`
      <a class="row lesson-row is-${l.status}" href="${href}">
        <div class="row-time">${time}</div>
        <div class="row-main">${main}</div>
        <div class="row-end">${photoMark(l)}${lessonBadges(l)}</div>
      </a>`;
  }
  const done = l.status === 'completed';
  return html`
    <div class="row lesson-row is-${l.status}">
      <a class="row-time" href="${href}">${time}</a>
      <a class="row-main" href="${href}">${main}</a>
      <div class="row-end">${photoMark(l)}${lessonBadges(l, { check: true })}</div>
      ${l.status === 'cancelled'
        ? html`<span class="check-spacer" aria-hidden="true"></span>`
        : html`<button type="button" class="check-btn ${done ? 'on' : ''}" data-action="lesson-done" data-id="${l.id}"
            aria-pressed="${done ? 'true' : 'false'}" aria-label="${t(done ? 'lesson.uncheckAria' : 'lesson.checkAria', { name: title })}">
            ${icon('check')}
          </button>`}
    </div>`;
}

// ---------- reminder times (lessons and planner reminders work the same way) ----------

export const REMIND_CHOICES = [1440, 240, 180, 120, 60, 30, 15, 5, 0];
export const offsetLabel = (min) => (min === 0 ? t('remind.atTime') : fmtOffset(min));

// The on/off switch and the reminder times for one lesson or planner reminder.
// live: every tap is saved straight away (detail screens); otherwise the values go into hidden form fields.
export function reminderPicker({ table, id = '', on, offsets, live = false }) {
  return html`
    <div class="remind-picker ${on ? '' : 'is-off'}" data-remind-picker data-table="${table}" data-id="${id}" data-live="${live ? '1' : ''}">
      <div class="card-title-row">
        <h2 class="card-title" data-remind-title>${icon(on ? 'bell' : 'bellOff')} ${t('remind.title')}</h2>
        <button type="button" class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}"
          aria-label="${t('remind.switchAria')}" data-action="remind-switch"><span></span></button>
      </div>
      <div class="chips remind-chips">
        ${REMIND_CHOICES.map(
          (m) => html`<button type="button" class="chip ${offsets.includes(m) ? 'on' : ''}" aria-pressed="${offsets.includes(m) ? 'true' : 'false'}" data-action="remind-offset" data-offset="${m}">${offsetLabel(m)}</button>`,
        )}
      </div>
      ${live ? '' : html`<input type="hidden" name="reminders_on" value="${on ? '1' : ''}"><input type="hidden" name="remind_offsets" value="${offsets.join(',')}">`}
    </div>`;
}

// "Notifications at 10:00, 11:00, 12:00" (times already passed are struck through).
export function reminderSummary(item, now = Date.now()) {
  if (!item.reminders_on) return html`<p class="muted small">${t('remind.off')}</p>`;
  const times = reminderTimes(item);
  if (!times.length) return html`<p class="muted small">${t('remind.none')}</p>`;
  return html`
    <p class="small">
      ${t('lesson.notificationsAt')}
      ${times.map((at, i) => html`${i ? ', ' : ''}<span class="${at < now ? 'past' : ''}">${sameDay(at, item.start_at) ? '' : `${dayLabel(at, now, { mid: true })} `}${fmtTime(at)}</span>`)}
    </p>`;
}

export const noPhoneWarning = () =>
  state.devices === 0
    ? html`<p class="warn small">${icon('alert')} ${t('common.noPhone')} <a href="#/settings">${t('common.turnThemOn')}</a>.</p>`
    : '';

export function moveChips() {
  return html`
    <div class="chips">
      <button type="button" class="chip" data-action="move" data-kind="-60">${t('move.minus1h')}</button>
      <button type="button" class="chip" data-action="move" data-kind="60">${t('move.plus1h')}</button>
      <button type="button" class="chip" data-action="move" data-kind="120">${t('move.plus2h')}</button>
      <button type="button" class="chip" data-action="move" data-kind="tomorrow">${t('move.tomorrow')}</button>
      <button type="button" class="chip" data-action="move" data-kind="week">${t('move.plusWeek')}</button>
      <button type="button" class="chip outline" data-action="pick-time">${t('move.pick')}</button>
    </div>`;
}

// A planner reminder in a list: time, title, the start of the note (two lines), and a tick circle.
// Like lessons: green when completed, struck through (and no circle) when cancelled.
export function eventRow(e) {
  const note = (e.note ?? '').trim();
  const done = e.status === 'completed';
  return html`
    <div class="row event-row is-${e.status}">
      <a class="row-time" href="#/event/${e.id}">
        <strong>${fmtTime(e.start_at)}</strong>
        ${rowMeta(e, e.duration_min)}
      </a>
      <a class="row-main" href="#/event/${e.id}">
        <div class="row-title"><span class="kind-dot" aria-hidden="true"></span>${e.title}</div>
        ${note ? html`<div class="row-sub clamp-2">${note}</div>` : ''}
      </a>
      ${e.status === 'cancelled'
        ? html`<div class="row-end"><span class="badge muted">${t('event.badgeCancelled')}</span></div><span class="check-spacer" aria-hidden="true"></span>`
        : html`<button type="button" class="check-btn ${done ? 'on' : ''}" data-action="event-done" data-id="${e.id}"
            aria-pressed="${done ? 'true' : 'false'}" aria-label="${t(done ? 'event.uncheckAria' : 'event.checkAria', { title: e.title })}">
            ${icon('check')}
          </button>`}
    </div>`;
}

export const agendaRow = ({ kind, item }) => (kind === 'lesson' ? lessonRow(item, { check: true }) : eventRow(item));

export function homeworkRow(h, { showStudent = false } = {}) {
  const s = showStudent ? student(h.student_id) : null;
  const meta = [s?.name, h.due_date ? t('hw.due', { date: fmtDay(fromKeys(h.due_date)) }) : null, t('hw.given', { date: fmtDay(h.created_at) })]
    .filter(Boolean)
    .join(' · ');
  return html`
    <div class="row hw-row hw-${h.status}">
      <button type="button" class="row-main plain" data-action="edit-homework" data-id="${h.id}">
        <div class="row-title wrap">${h.text}</div>
        <div class="row-sub">${meta}</div>
      </button>
      <div class="row-actions">
        ${h.status === 'open'
          ? html`
              <button type="button" class="icon-btn success" data-action="hw-status" data-id="${h.id}" data-status="done" aria-label="${t('hw.done')}">${icon('check')}</button>
              <button type="button" class="icon-btn danger" data-action="hw-status" data-id="${h.id}" data-status="missed" aria-label="${t('hw.missed')}">${icon('x')}</button>`
          : html`
              <span class="badge ${h.status === 'done' ? 'success' : 'danger'}">${t(h.status === 'done' ? 'hw.done' : 'hw.missed')}</span>
              <button type="button" class="icon-btn" data-action="hw-status" data-id="${h.id}" data-status="open" aria-label="${t('hw.reopen')}">${icon('undo')}</button>`}
      </div>
    </div>`;
}

export function deviceWarning() {
  if (state.devices > 0) return '';
  return html`
    <a class="card notice" href="#/settings">
      ${icon('bell')}
      <div><strong>${t('device.title')}</strong><span>${t('device.text')}</span></div>
      ${icon('chevronRight')}
    </a>`;
}

export function offlineBanner() {
  if (!state.offline) return '';
  return html`<div class="card notice muted-notice">${icon('wifiOff')}<div><strong>${t('offline.title')}</strong><span>${t('offline.text')}</span></div></div>`;
}
