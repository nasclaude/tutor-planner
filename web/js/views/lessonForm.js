import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, tn, cap } from '../i18n.js';
import { state, lesson, student, createRow, createSeries, updateRow, findOverlap, offsetsOf, notifies } from '../store.js';
import { dateKey, timeKey, fromKeys, fmtMinutes, fmtTime, fmtDay, fmtDayMonth, fmtWeekdayLong, HOUR } from '../time.js';
import { pageHeader, notFound, emptyState, field, reminderPicker } from '../components.js';
import { go, toast, confirmSheet, formValues } from '../ui.js';
import { repeatSheet } from '../actions.js';

export function nextFullHour() {
  const d = new Date(Date.now() + HOUR);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// The picker keeps its values in two hidden fields: "1" / "" and "180,120,60".
export const readReminderFields = (v) => ({
  reminders_on: v.reminders_on === '1',
  remind_offsets: v.remind_offsets ? v.remind_offsets.split(',').map(Number) : [],
});

export default {
  title: (ctx) => t(ctx.params.id ? 'lessonForm.edit' : 'lessonForm.new'),
  render(ctx) {
    const editing = ctx.params.id ? lesson(ctx.params.id) : null;
    if (ctx.params.id && !editing) return notFound(t('lesson.notFound'), '#/');
    const q = ctx.query;
    const back = editing ? `#/lesson/${editing.id}` : '#/';
    const title = t(editing ? 'lessonForm.edit' : 'lessonForm.new');

    const students = state.students.filter((s) => !s.archived || s.id === editing?.student_id || s.id === q.get('student'));
    if (!students.length) {
      return html`
        ${pageHeader({ title, back })}
        ${emptyState({
          icon: 'users',
          title: t('lessonForm.needStudent'),
          text: t('lessonForm.needStudentText'),
          action: html`<a class="btn primary" href="#/student/new">${icon('plus')} ${t('lessonForm.addStudent')}</a>`,
        })}`;
    }

    const studentId = editing?.student_id ?? q.get('student') ?? (students.length === 1 ? students[0].id : '');
    const start = editing?.start_at ?? (q.get('start') ? Number(q.get('start')) : nextFullHour());
    const duration = editing?.duration_min ?? state.settings.default_duration;
    const price = editing ? editing.price : student(studentId)?.price;
    const durations = [...new Set([30, 45, 60, 90, 120, duration])].sort((a, b) => a - b);
    const remindersOn = editing ? !!editing.reminders_on : true;
    const offsets = editing ? offsetsOf(editing) : [...state.settings.reminder_offsets];

    return html`
      ${pageHeader({ title, back })}
      <form data-form="save" class="card pad stack">
        ${field(
          t('lessonForm.student'),
          html`<select name="student_id" required>
            <option value="" disabled ${studentId ? '' : 'selected'}>${t('lessonForm.choose')}</option>
            ${students.map((s) => html`<option value="${s.id}" ${s.id === studentId ? 'selected' : ''}>${s.name}${s.subject ? ` — ${s.subject}` : ''}</option>`)}
          </select>`,
        )}
        <div class="field-row">
          ${field(t('common.date'), html`<input type="date" name="date" value="${dateKey(start)}" required>`)}
          ${field(t('common.time'), html`<input type="time" name="time" value="${timeKey(start)}" required>`)}
        </div>
        <div class="field-row">
          ${field(t('common.length'), html`<select name="duration_min">${durations.map((d) => html`<option value="${d}" ${d === duration ? 'selected' : ''}>${fmtMinutes(d)}</option>`)}</select>`)}
          ${field(t('common.price'), html`<input type="number" name="price" inputmode="decimal" min="0" step="0.01" value="${price ?? ''}" placeholder="${state.settings.currency || '—'}">`)}
        </div>
        ${field(t('lessonForm.topic'), html`<input name="topic" value="${editing?.topic ?? ''}" placeholder="${t('lessonForm.topicPlaceholder')}" autocomplete="off">`, true)}
        <div class="form-section">${reminderPicker({ table: 'lessons', on: remindersOn, offsets })}</div>
        <button class="btn primary block big" type="submit">${t(editing ? 'common.saveChanges' : 'lessonForm.add')}</button>
        ${editing ? '' : html`<p class="muted small center">${t('lessonForm.notInList')} <a href="#/student/new">${t('lessonForm.addNewStudent')}</a></p>`}
      </form>`;
  },
  mounted(root) {
    const form = root.querySelector('form[data-form=save]');
    if (!form) return;
    const price = form.elements.namedItem('price');
    const select = form.elements.namedItem('student_id');
    price.addEventListener('input', () => (price.dataset.touched = '1'));
    // Fill in the student's usual price unless you've typed one.
    select.addEventListener('change', () => {
      if (!price.dataset.touched) price.value = student(select.value)?.price ?? '';
    });
  },
  forms: {
    async save(form, ctx) {
      const editing = ctx.params.id ? lesson(ctx.params.id) : null;
      const v = formValues(form);
      const start = fromKeys(v.date, v.time);
      const duration = Number(v.duration_min);
      const clash = findOverlap(start, duration, editing?.id);
      if (clash) {
        const ok = await confirmSheet({
          title: t('common.timeClash'),
          message: t('lessonForm.clashSave', { name: student(clash.student_id)?.name ?? t('lesson.title'), time: fmtTime(clash.start_at) }),
          confirmLabel: t('lessonForm.saveAnyway'),
        });
        if (!ok) return;
      }
      const data = {
        student_id: v.student_id,
        start_at: start,
        duration_min: duration,
        topic: v.topic,
        price: v.price === '' ? null : Number(v.price),
        ...readReminderFields(v),
      };
      if (editing) {
        await updateRow('lessons', editing.id, data);
        go(`#/lesson/${editing.id}`, { replace: true });
        toast(t('lessonForm.updated'));
        return;
      }
      // A new lesson: once, or repeating (e.g. every Tuesday for 3 months)?
      const who = student(v.student_id)?.name ?? '';
      repeatSheet({
        table: 'lessons',
        start,
        summary: `${cap(fmtWeekdayLong(start))}, ${fmtDayMonth(start)} · ${fmtTime(start)} · ${who}`,
        async onPick(starts) {
          const rows = starts.length === 1 ? [await createRow('lessons', data)] : await createSeries('lessons', starts.map((s) => ({ ...data, start_at: s })));
          go(`#/lesson/${rows[0].id}`, { replace: true });
          if (rows.length === 1) {
            const remind = notifies(rows[0]) && rows[0].start_at > Date.now();
            toast(remind ? `${t('lessonForm.added')} · ${t('lessonForm.remindersSet')}` : t('lessonForm.added'));
            return;
          }
          const clashes = rows.slice(1).filter((r) => findOverlap(r.start_at, r.duration_min, r.id)).length;
          const added = t('repeat.added', { count: tn('n.lessons', rows.length), date: fmtDay(rows[rows.length - 1].start_at) });
          toast(clashes ? `${added} · ${tn('repeat.clashes', clashes)}` : added);
        },
      });
    },
  },
};
