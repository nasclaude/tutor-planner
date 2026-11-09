import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { state, nextLesson, owed } from '../store.js';
import { fmtTime, dayLabel } from '../time.js';
import { pageHeader, emptyState, fab, avatar, fmtMoney } from '../components.js';

function studentRow(s, now) {
  const next = nextLesson(s.id, now);
  const due = owed(s.id);
  const search = [s.name, s.subject, s.grade_level, s.school].filter(Boolean).join(' ').toLowerCase();
  return html`
    <a class="row student-row" href="#/student/${s.id}" data-search="${search}">
      ${avatar(s)}
      <div class="row-main">
        <div class="row-title">${s.name}</div>
        <div class="row-sub">${[s.subject, s.grade_level].filter(Boolean).join(' · ') || t('students.noDetails')}</div>
      </div>
      <div class="row-end">
        ${due > 0
          ? html`<span class="badge warn">${t('students.owes', { amount: fmtMoney(due) })}</span>`
          : next
            ? html`<span class="small">${dayLabel(next.start_at, now)} ${fmtTime(next.start_at)}</span>`
            : ''}
        ${icon('chevronRight')}
      </div>
    </a>`;
}

export default {
  tab: 'students',
  title: () => t('students.title'),
  render(ctx) {
    const now = Date.now();
    const archivedView = ctx.query.get('archived') === '1';
    const list = state.students.filter((s) => !!s.archived === archivedView);
    const archivedCount = state.students.filter((s) => s.archived).length;

    return html`
      ${pageHeader({
        title: t(archivedView ? 'students.archivedTitle' : 'students.title'),
        subtitle: tn('n.students', list.length),
        back: archivedView ? '#/students' : null,
      })}
      ${list.length > 4
        ? html`<label class="search">${icon('search')}<input type="search" placeholder="${t('students.search')}" data-search-input autocomplete="off" aria-label="${t('students.searchAria')}"></label>`
        : ''}
      ${list.length
        ? html`<div class="card list" data-student-list>${list.map((s) => studentRow(s, now))}</div><p class="muted small center" data-no-results hidden>${t('students.noMatch')}</p>`
        : archivedView
          ? html`<div class="card empty-row">${t('students.noArchived')}</div>`
          : emptyState({
              icon: 'users',
              title: t('students.emptyTitle'),
              text: t('students.emptyText'),
              action: html`<a class="btn primary" href="#/student/new">${icon('plus')} ${t('students.add')}</a>`,
            })}
      ${!archivedView && archivedCount ? html`<p class="center"><a class="small" href="#/students?archived=1">${t('students.showArchived', { n: archivedCount })}</a></p>` : ''}
      ${archivedView ? '' : fab('#/student/new', t('students.add'))}`;
  },
  mounted(root) {
    const input = root.querySelector('[data-search-input]');
    if (!input) return;
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const row of root.querySelectorAll('[data-student-list] .student-row')) {
        const match = !q || row.dataset.search.includes(q);
        row.hidden = !match;
        if (match) shown++;
      }
      root.querySelector('[data-no-results]').hidden = shown > 0;
    });
  },
};
