import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, tn, names } from '../i18n.js';
import { state, student, createRow, updateRow, deleteRow } from '../store.js';
import { pageHeader, notFound, field } from '../components.js';
import { go, toast, confirmSheet, formValues } from '../ui.js';

export default {
  tab: 'students',
  title: (ctx) => t(ctx.params.id ? 'studentForm.edit' : 'studentForm.new'),
  render(ctx) {
    const s = ctx.params.id ? student(ctx.params.id) : null;
    if (ctx.params.id && !s) return notFound(t('student.notFound'), '#/students');
    const v = s ?? {};
    const subjects = [...new Set([...state.students.map((x) => x.subject).filter(Boolean), ...names().subjects])];

    return html`
      ${pageHeader({ title: t(s ? 'studentForm.edit' : 'studentForm.new'), back: s ? `#/student/${s.id}` : '#/students' })}
      <form data-form="save" class="stack">
        <section class="card pad stack">
          ${field(t('studentForm.name'), html`<input name="name" value="${v.name ?? ''}" required maxlength="120" autocomplete="off" placeholder="${t('studentForm.namePlaceholder')}">`)}
          <div class="field-row">
            ${field(t('studentForm.subject'), html`<input name="subject" value="${v.subject ?? ''}" list="subject-list" maxlength="120" placeholder="${t('studentForm.subjectPlaceholder')}">`)}
            ${field(t('studentForm.grade'), html`<input name="grade_level" value="${v.grade_level ?? ''}" list="grade-list" maxlength="60" placeholder="${t('studentForm.gradePlaceholder')}">`)}
          </div>
          ${field(t('studentForm.school'), html`<input name="school" value="${v.school ?? ''}" maxlength="120">`, true)}
          <div class="field-row">
            ${field(t('studentForm.phone'), html`<input name="phone" type="tel" value="${v.phone ?? ''}" maxlength="40">`, true)}
            ${field(t('studentForm.price'), html`<input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${v.price ?? ''}" placeholder="${state.settings.currency || '—'}">`)}
          </div>
        </section>
        <section class="card pad stack">
          <h2 class="card-title">${t('studentForm.parentTitle')}</h2>
          <div class="field-row">
            ${field(t('studentForm.parentName'), html`<input name="parent_name" value="${v.parent_name ?? ''}" maxlength="120">`, true)}
            ${field(t('studentForm.parentPhone'), html`<input name="parent_phone" type="tel" value="${v.parent_phone ?? ''}" maxlength="40">`, true)}
          </div>
        </section>
        <section class="card pad stack">
          ${field(t('studentForm.notes'), html`<textarea name="notes" rows="4" placeholder="${t('studentForm.notesPlaceholder')}">${v.notes ?? ''}</textarea>`, true)}
          ${s ? html`<label class="check"><input type="checkbox" name="archived" ${s.archived ? 'checked' : ''}> ${t('studentForm.archived')}</label>` : ''}
        </section>
        <button class="btn primary block big" type="submit">${t(s ? 'common.saveChanges' : 'studentForm.add')}</button>
        ${s ? html`<button type="button" class="btn block danger-ghost" data-action="delete-student">${icon('trash')} ${t('studentForm.delete')}</button>` : ''}
      </form>
      <datalist id="grade-list">${names().gradeLevels.map((g) => html`<option value="${g}"></option>`)}</datalist>
      <datalist id="subject-list">${subjects.map((x) => html`<option value="${x}"></option>`)}</datalist>`;
  },
  forms: {
    async save(form, ctx) {
      const editing = ctx.params.id ? student(ctx.params.id) : null;
      const v = formValues(form);
      const data = {
        name: v.name,
        subject: v.subject,
        grade_level: v.grade_level,
        school: v.school,
        phone: v.phone,
        parent_name: v.parent_name,
        parent_phone: v.parent_phone,
        price: v.price === '' ? null : Number(v.price),
        notes: v.notes,
      };
      if (editing) data.archived = v.archived;
      const row = editing ? await updateRow('students', editing.id, data) : await createRow('students', data);
      go(`#/student/${row.id}`, { replace: true });
      toast(editing ? t('studentForm.saved') : t('studentForm.added', { name: row.name }));
    },
  },
  actions: {
    async 'delete-student'(el, ctx) {
      const s = student(ctx.params.id);
      const lessons = state.lessons.filter((l) => l.student_id === s.id).length;
      const ok = await confirmSheet({
        title: t('studentForm.deleteTitle', { name: s.name }),
        message: t('studentForm.deleteText', { count: tn('n.lessons', lessons) }),
        confirmLabel: t('studentForm.delete'),
        danger: true,
      });
      if (!ok) return;
      await deleteRow('students', s.id);
      go('#/students', { replace: true });
      toast(t('studentForm.deleted', { name: s.name }));
    },
  },
};
