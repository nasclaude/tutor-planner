import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { state, student, lessonEnd, nextLesson, owed, studentMoney, createRow, updateRow, deleteRow } from '../store.js';
import { fmtTime, fmtDay, fmtRelative, dayLabel, dateKey, fromKeys } from '../time.js';
import { pageHeader, notFound, avatar, stat, lessonRow, homeworkRow, fmtMoney, telHref, field } from '../components.js';
import { homeworkSheet } from '../actions.js';
import { openSheet, toast, rerender, formValues } from '../ui.js';

const TABS = ['overview', 'lessons', 'grades', 'homework'];

// Average of plain numeric grades ("5", "5.5", "5,5"); letter grades are skipped.
function averageGrade(grades) {
  const nums = grades
    .map((g) => String(g.value).trim())
    .filter((v) => /^\d+([.,]\d+)?$/.test(v))
    .map((v) => Number(v.replace(',', '.')));
  if (!nums.length) return null;
  return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2).replace(/\.?0+$/, '');
}

// Whole percent, but never "100%" before everything is paid, nor "0%" once something is.
function share(part, whole) {
  if (!(whole > 0)) return null;
  if (part >= whole) return 100;
  if (part <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round((part / whole) * 100)));
}

function detail(label, value) {
  if (value == null || value === '') return '';
  return html`<dt>${label}</dt><dd>${value}</dd>`;
}

function overview(s) {
  const now = Date.now();
  const next = nextLesson(s.id, now);
  const done = state.lessons.filter((l) => l.student_id === s.id && l.status === 'completed');
  const due = owed(s.id);
  const money = studentMoney(s.id);
  const paidShare = share(money.paid, money.total);
  const grades = state.grades.filter((g) => g.student_id === s.id);
  const avg = averageGrade(grades);
  const parent =
    s.parent_name || s.parent_phone
      ? html`${s.parent_name ?? ''}${s.parent_name && s.parent_phone ? ' · ' : ''}${s.parent_phone ? html`<a href="${telHref(s.parent_phone)}">${s.parent_phone}</a>` : ''}`
      : null;

  return html`
    <div class="stats">
      ${stat(
        t('student.nextLesson'),
        next ? `${dayLabel(next.start_at, now)} ${fmtTime(next.start_at)}` : '—',
        next ? fmtRelative(next.start_at, now) : html`<a href="#/lesson/new?student=${s.id}">${t('student.schedule')}</a>`,
      )}
      ${stat(t('student.lessonsDone'), String(done.length), done.length ? t('student.lastOn', { date: fmtDay(done[done.length - 1].start_at) }) : t('student.noneYet'))}
      ${stat(t('student.totalValue'), fmtMoney(money.total), money.lessons ? tn('student.forLessons', money.lessons) : t('student.noneYet'))}
      ${stat(
        t('student.alreadyPaid'),
        fmtMoney(money.paid),
        paidShare == null ? '' : t('student.paidShare', { p: paidShare }),
        money.paid > 0 ? 'success' : '',
      )}
      ${stat(
        t('student.owes'),
        fmtMoney(due),
        due > 0 ? html`<button type="button" class="link" data-action="pay-all" data-student="${s.id}">${t('student.markAllPaid')}</button>` : t('student.allPaid'),
        due > 0 ? 'warn' : '',
      )}
      ${stat(t('student.average'), avg ?? '—', grades.length ? tn('n.grades', grades.length) : t('student.noGrades'))}
    </div>
    ${money.noPrice ? html`<p class="muted small">${tn('student.noPrice', money.noPrice)}</p>` : ''}
    <section class="card pad">
      <h2 class="card-title">${t('student.details')}</h2>
      <dl class="details">
        ${detail(t('student.subject'), s.subject)}
        ${detail(t('student.gradeLevel'), s.grade_level)}
        ${detail(t('student.school'), s.school)}
        ${detail(t('student.phone'), s.phone ? html`<a href="${telHref(s.phone)}">${s.phone}</a>` : null)}
        ${detail(t('student.parentLabel'), parent)}
        ${detail(t('student.price'), s.price != null ? t('student.perLesson', { amount: fmtMoney(s.price) }) : null)}
      </dl>
      <h3 class="sub-title">${t('student.notes')}</h3>
      ${s.notes
        ? html`<p class="notes">${s.notes}</p>`
        : html`<p class="muted small">${t('student.noNotes')} <a href="#/student/${s.id}/edit">${t('student.addNotes')}</a></p>`}
    </section>`;
}

function lessonsTab(s) {
  const now = Date.now();
  const all = state.lessons.filter((l) => l.student_id === s.id);
  const upcoming = all.filter((l) => l.status === 'scheduled' && lessonEnd(l) > now);
  const past = all.filter((l) => !upcoming.includes(l)).reverse();
  const list = (items, empty) =>
    items.length
      ? html`<div class="card list">${items.map((l) => lessonRow(l, { date: true, showStudent: false }))}</div>`
      : html`<div class="card empty-row">${empty}</div>`;
  return html`
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">${t('student.upcoming')}</h2>
        <a class="btn small" href="#/lesson/new?student=${s.id}">${icon('plus')} ${t('student.addLesson')}</a>
      </div>
      ${list(upcoming, t('student.noUpcoming'))}
    </section>
    <section class="section">
      <h2 class="section-title">${t('student.history')}</h2>
      ${list(past, t('student.noPast'))}
    </section>`;
}

function gradesTab(s) {
  const grades = state.grades.filter((g) => g.student_id === s.id);
  return html`
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">${t('student.grades')}</h2>
        <button type="button" class="btn small primary" data-action="add-grade">${icon('plus')} ${t('student.addGrade')}</button>
      </div>
      ${grades.length
        ? html`<div class="card list">
            ${grades.map(
              (g) => html`
                <button type="button" class="row grade-row" data-action="edit-grade" data-id="${g.id}">
                  <span class="grade-value">${g.value}</span>
                  <div class="row-main">
                    <div class="row-title">${g.title || t('student.gradeDefault')}</div>
                    <div class="row-sub">${fmtDay(fromKeys(g.date))}${g.note ? ` · ${g.note}` : ''}</div>
                  </div>
                  ${icon('chevronRight')}
                </button>`,
            )}
          </div>`
        : html`<div class="card empty-row">${t('student.gradesEmpty')}</div>`}
    </section>`;
}

function homeworkTab(s) {
  const all = state.homework.filter((h) => h.student_id === s.id);
  const open = all.filter((h) => h.status === 'open');
  const checked = all.filter((h) => h.status !== 'open');
  return html`
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">${t('student.todo')}</h2>
        <button type="button" class="btn small primary" data-action="add-homework">${icon('plus')} ${t('student.addHomework')}</button>
      </div>
      ${open.length ? html`<div class="card list">${open.map((h) => homeworkRow(h))}</div>` : html`<div class="card empty-row">${t('student.noOpenHomework')}</div>`}
    </section>
    ${checked.length
      ? html`<section class="section"><h2 class="section-title">${t('student.checked')}</h2><div class="card list">${checked.map((h) => homeworkRow(h))}</div></section>`
      : ''}`;
}

function gradeSheet(studentId, g = null) {
  openSheet({
    title: t(g ? 'grade.editTitle' : 'grade.addTitle'),
    body: html`
      <div class="field-row">
        ${field(t('grade.value'), html`<input name="value" value="${g?.value ?? ''}" required maxlength="20" placeholder="${t('grade.valuePlaceholder')}" autocomplete="off">`)}
        ${field(t('common.date'), html`<input type="date" name="date" value="${g?.date ?? dateKey(Date.now())}" required>`)}
      </div>
      ${field(t('grade.forWhat'), html`<input name="title" value="${g?.title ?? ''}" placeholder="${t('grade.forWhatPlaceholder')}" autocomplete="off">`, true)}
      ${field(t('grade.note'), html`<textarea name="note" rows="2">${g?.note ?? ''}</textarea>`, true)}`,
    submitLabel: t(g ? 'common.save' : 'grade.add'),
    danger: g ? { label: t('common.delete'), action: 'delete' } : null,
    actions: {
      async delete() {
        await deleteRow('grades', g.id);
        rerender();
        toast(t('grade.deleted'));
      },
    },
    async onSubmit(form) {
      const v = formValues(form);
      const data = { value: v.value, date: v.date, title: v.title, note: v.note };
      if (g) await updateRow('grades', g.id, data);
      else await createRow('grades', { ...data, student_id: studentId });
      rerender();
      toast(t(g ? 'grade.saved' : 'grade.added'));
    },
  });
}

export default {
  tab: 'students',
  title: (ctx) => student(ctx.params.id)?.name ?? t('students.title'),
  render(ctx) {
    const s = student(ctx.params.id);
    if (!s) return notFound(t('student.notFound'), '#/students');
    const tab = ctx.params.tab || 'overview';
    const openHomework = state.homework.filter((h) => h.student_id === s.id && h.status === 'open').length;
    const body = { overview, lessons: lessonsTab, grades: gradesTab, homework: homeworkTab }[tab](s);

    return html`
      ${pageHeader({ back: '#/students', right: html`<a class="btn small" href="#/student/${s.id}/edit">${icon('edit')} ${t('common.edit')}</a>` })}
      <div class="profile">
        ${avatar(s, 'lg')}
        <div class="profile-text">
          <h1>${s.name}</h1>
          <p class="subtitle">${[s.subject, s.grade_level, s.school].filter(Boolean).join(' · ') || t('students.noDetails')}</p>
          ${s.archived ? html`<span class="badge muted">${t('badge.archived')}</span>` : ''}
        </div>
      </div>
      <div class="quick-actions">
        <a class="btn primary" href="#/lesson/new?student=${s.id}">${icon('plus')} ${t('student.lessonBtn')}</a>
        ${s.phone ? html`<a class="btn" href="${telHref(s.phone)}">${icon('phone')} ${t('student.call')}</a>` : ''}
        ${s.parent_phone ? html`<a class="btn" href="${telHref(s.parent_phone)}">${icon('phone')} ${t('student.parent')}</a>` : ''}
      </div>
      <nav class="segmented" aria-label="${t('student.sectionsAria')}">
        ${TABS.map(
          (key) => html`
            <a href="#/student/${s.id}${key === 'overview' ? '' : `/${key}`}" class="${key === tab ? 'active' : ''}" ${key === tab ? html`aria-current="page"` : ''}>
              ${t(`student.tab.${key}`)}${key === 'homework' && openHomework ? html` <span class="count">${openHomework}</span>` : ''}
            </a>`,
        )}
      </nav>
      ${body}`;
  },
  actions: {
    'add-grade': (el, ctx) => gradeSheet(ctx.params.id),
    'edit-grade': (el, ctx) => gradeSheet(ctx.params.id, state.grades.find((g) => g.id === el.dataset.id)),
    'add-homework': (el, ctx) => homeworkSheet(ctx.params.id),
  },
};
