import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, cap } from '../i18n.js';
import { state, student, lessonEnd, nextLesson, agenda, notifies, needsMarking } from '../store.js';
import { fmtTime, fmtDayLong, fmtRelative, dayLabel, startOfDay, addDays, dateKey } from '../time.js';
import { pageHeader, agendaRow, emptyState, fab, deviceWarning, offlineBanner } from '../components.js';
import { lessonActions } from '../actions.js';

function nextCard(l, now) {
  const s = student(l.student_id);
  const live = l.start_at <= now;
  return html`
    <a class="card next-card" href="#/lesson/${l.id}">
      <div class="next-top">
        <span class="pill ${live ? 'live' : ''}">${t(live ? 'today.happeningNow' : 'today.nextLesson')}</span>
        <span>${dayLabel(l.start_at, now)}</span>
      </div>
      <div class="next-main">
        <div class="next-time">${fmtTime(l.start_at)}</div>
        <div class="next-who">
          <div class="next-name">${s?.name ?? t('common.unknownStudent')}</div>
          <div class="next-sub">${[s?.subject, s?.grade_level, l.topic].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <div class="next-foot">
        ${icon('clock')}
        <span>${live ? t('today.ends', { rel: fmtRelative(lessonEnd(l), now) }) : t('today.starts', { rel: fmtRelative(l.start_at, now) })}</span>
        ${notifies(l) ? '' : html`<span class="badge">${icon('bellOff')} ${t('badge.remindersOff')}</span>`}
      </div>
    </a>`;
}

function attentionRow(l, now) {
  const s = student(l.student_id);
  return html`
    <div class="row attention-row">
      <a class="row-main" href="#/lesson/${l.id}">
        <div class="row-title">${s?.name ?? t('common.unknownStudent')}</div>
        <div class="row-sub">${dayLabel(l.start_at, now)} · ${fmtTime(l.start_at)}</div>
      </a>
      <div class="row-actions">
        <button type="button" class="btn small success" data-action="complete" data-id="${l.id}">${icon('check')} ${t('today.done')}</button>
        <button type="button" class="btn small ghost" data-action="cancel" data-id="${l.id}">${t('today.didntHappen')}</button>
      </div>
    </div>`;
}

export default {
  tab: 'today',
  title: () => t('today.title'),
  live: true,
  render() {
    const now = Date.now();
    const header = pageHeader({ title: t('today.title'), subtitle: cap(fmtDayLong(now)) });

    if (!state.students.length && !state.events.length) {
      return html`
        ${header}
        ${emptyState({
          icon: 'calendar',
          title: t('today.welcomeTitle'),
          text: t('today.welcomeText'),
          action: html`
            <div class="btn-row center-row">
              <a class="btn primary big" href="#/student/new">${icon('plus')} ${t('today.addStudent')}</a>
              <a class="btn big" href="#/event/new">${icon('bell')} ${t('today.addReminder')}</a>
            </div>`,
        })}`;
    }

    const dayStart = startOfDay(now);
    const tomorrow = addDays(dayStart, 1);
    const next = nextLesson(null, now);
    const attention = needsMarking(now).reverse();
    const today = agenda(dayStart, tomorrow);
    const days = [];
    const scheduled = (item) => item.status === 'scheduled';
    for (const entry of agenda(tomorrow, addDays(dayStart, 8), { lessons: scheduled, events: scheduled })) {
      const key = dateKey(entry.item.start_at);
      let group = days.find((d) => d.key === key);
      if (!group) days.push((group = { key, ms: entry.item.start_at, entries: [] }));
      group.entries.push(entry);
    }

    return html`
      ${header}
      ${offlineBanner()}
      ${state.me?.must_change_password
        ? html`<button type="button" class="card notice notice-button" data-action="change-password">
            ${icon('key')}<div><strong>${t('password.mustChangeTitle')}</strong><span>${t('password.mustChangeText')}</span></div>${icon('chevronRight')}
          </button>`
        : ''}
      ${deviceWarning()}
      ${next ? nextCard(next, now) : ''}
      ${attention.length
        ? html`
            <section class="section">
              <h2 class="section-title attention">${icon('alert')} ${t(attention.length === 1 ? 'today.didItHappen.one' : 'today.didItHappen.other')}</h2>
              <div class="card list">${attention.slice(0, 10).map((l) => attentionRow(l, now))}</div>
            </section>`
        : ''}
      <section class="section">
        <h2 class="section-title">${t('today.title')}</h2>
        ${today.length
          ? html`<div class="card list">${today.map(agendaRow)}</div>`
          : html`<div class="card empty-row">${t('today.empty')} <button type="button" class="link" data-action="add-menu">${t('today.addSomething')}</button></div>`}
      </section>
      <section class="section">
        <h2 class="section-title">${t('today.next7')}</h2>
        ${days.length
          ? days.map((d) => html`<h3 class="day-title">${cap(dayLabel(d.ms, now))}</h3><div class="card list">${d.entries.map(agendaRow)}</div>`)
          : html`<div class="card empty-row">${t('today.nothingScheduled')}</div>`}
      </section>
      ${fab(null, t('add.aria'), { chooser: true })}`;
  },
  actions: lessonActions,
};
