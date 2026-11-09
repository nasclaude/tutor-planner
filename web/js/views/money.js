import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, tn, cap } from '../i18n.js';
import { state, student, unpaidLessons } from '../store.js';
import { fmtTime, fmtDay, fmtMonth, monthKey, startOfMonth, addMonths, fromKeys } from '../time.js';
import { pageHeader, stat, avatar, fmtMoney } from '../components.js';

const total = (lessons) => lessons.reduce((sum, l) => sum + (l.price || 0), 0);

function groupByStudent(lessons) {
  const groups = new Map();
  for (const l of lessons) {
    if (!groups.has(l.student_id)) groups.set(l.student_id, { s: student(l.student_id), lessons: [] });
    groups.get(l.student_id).lessons.push(l);
  }
  return [...groups.values()].map((g) => ({ ...g, total: total(g.lessons) })).sort((a, b) => b.total - a.total);
}

function owingCard({ s, lessons, total: sum }) {
  return html`
    <div class="card owing">
      <div class="owing-head">
        <a class="owing-who" href="#/student/${s?.id}">
          ${avatar(s)}
          <div class="row-main">
            <div class="row-title">${s?.name ?? t('common.unknownStudent')}</div>
            <div class="row-sub">${tn('n.unpaidLessons', lessons.length)}</div>
          </div>
        </a>
        <strong class="owing-total">${fmtMoney(sum)}</strong>
      </div>
      <div class="list">
        ${lessons.map(
          (l) => html`
            <div class="row compact">
              <a class="row-main" href="#/lesson/${l.id}"><div class="row-sub">${fmtDay(l.start_at)} · ${fmtTime(l.start_at)}</div></a>
              <span class="amount">${fmtMoney(l.price)}</span>
              <button type="button" class="btn small" data-action="pay" data-id="${l.id}">${t('money.paidBtn')}</button>
            </div>`,
        )}
      </div>
      ${lessons.length > 1
        ? html`<button type="button" class="btn block success-soft" data-action="pay-all" data-student="${s?.id}">${icon('check')} ${t('money.markAll')}</button>`
        : ''}
    </div>`;
}

export default {
  tab: 'money',
  title: () => t('money.title'),
  render(ctx) {
    const month = ctx.params.month ? fromKeys(`${ctx.params.month}-01`) : startOfMonth(Date.now());
    const from = startOfMonth(month);
    const to = addMonths(month, 1);
    const inMonth = state.lessons.filter((l) => l.start_at >= from && l.start_at < to);
    const done = inMonth.filter((l) => l.status === 'completed');
    const planned = inMonth.filter((l) => l.status === 'scheduled');
    const earned = total(done);
    const received = total(done.filter((l) => l.paid));
    const noPrice = done.filter((l) => !(l.price > 0)).length;
    const owing = groupByStudent(unpaidLessons());
    const byStudent = groupByStudent(done);
    const monthName = cap(fmtMonth(month));

    return html`
      ${pageHeader({
        title: t('money.title'),
        subtitle: monthName,
        right: html`
          <a class="icon-btn" href="#/money/${monthKey(addMonths(month, -1))}" aria-label="${t('money.prev')}">${icon('chevronLeft')}</a>
          <a class="icon-btn" href="#/money/${monthKey(addMonths(month, 1))}" aria-label="${t('money.next')}">${icon('chevronRight')}</a>`,
      })}
      <div class="stats">
        ${stat(t('money.earned'), fmtMoney(earned), tn('n.completedLessons', done.length))}
        ${stat(t('money.received'), fmtMoney(received), earned ? t('money.percentPaid', { p: Math.round((received / earned) * 100) }) : '—', 'success')}
        ${stat(t('money.unpaid'), fmtMoney(earned - received), t('money.fromThisMonth'), earned - received > 0 ? 'warn' : '')}
        ${stat(t('money.planned'), fmtMoney(total(planned)), tn('n.upcomingLessons', planned.length))}
      </div>
      ${noPrice ? html`<p class="muted small">${tn('money.noPrice', noPrice)}</p>` : ''}

      <section class="section">
        <h2 class="section-title">${t('money.whoOwes')}</h2>
        ${owing.length ? owing.map(owingCard) : html`<div class="card empty-row">${icon('check')} ${t('money.allPaid')}</div>`}
      </section>

      <section class="section">
        <h2 class="section-title">${t('money.byStudent', { month: monthName })}</h2>
        ${byStudent.length
          ? html`<div class="card list">
              ${byStudent.map(
                (g) => html`
                  <a class="row" href="#/student/${g.s?.id}">
                    ${avatar(g.s)}
                    <div class="row-main">
                      <div class="row-title">${g.s?.name ?? t('common.unknownStudent')}</div>
                      <div class="row-sub">${tn('n.lessons', g.lessons.length)}</div>
                    </div>
                    <span class="amount">${fmtMoney(g.total)}</span>
                  </a>`,
              )}
            </div>`
          : html`<div class="card empty-row">${t('money.noneInMonth', { month: fmtMonth(month) })}</div>`}
      </section>`;
  },
};
