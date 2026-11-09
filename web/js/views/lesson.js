import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, cap } from '../i18n.js';
import { state, lesson, student, lessonEnd, offsetsOf, updateRow, createRow } from '../store.js';
import { fmtTime, fmtDayLong, fmtDay, fmtRelative } from '../time.js';
import {
  pageHeader, notFound, avatar, lessonBadges, homeworkRow, fmtMoney, firstName,
  reminderPicker, reminderSummary, noPhoneWarning, moveChips,
} from '../components.js';
import { lessonActions } from '../actions.js';
import { toast, rerender, formValues } from '../ui.js';

function timing(l, now) {
  const end = lessonEnd(l);
  if (l.start_at > now) return t('today.starts', { rel: fmtRelative(l.start_at, now) });
  if (end > now) return t('lesson.inProgress');
  return t('lesson.ended', { rel: fmtRelative(end, now) });
}

function scheduledSections(l, now) {
  return html`
    <div class="action-pair">
      <button type="button" class="btn success big" data-action="complete">${icon('check')} ${t('lesson.completedBtn')}</button>
      <button type="button" class="btn danger-soft big" data-action="cancel">${icon('x')} ${t('lesson.cancelBtn')}</button>
    </div>

    <section class="card pad">
      <h2 class="card-title">${icon('clock')} ${t('lesson.moveCard')}</h2>
      ${moveChips()}
    </section>

    <section class="card pad">
      ${reminderPicker({ table: 'lessons', id: l.id, on: !!l.reminders_on, offsets: offsetsOf(l), live: true })}
      ${reminderSummary(l, now)}
      ${l.reminders_on ? noPhoneWarning() : ''}
    </section>`;
}

export default {
  title: (ctx) => student(lesson(ctx.params.id)?.student_id)?.name ?? t('lesson.title'),
  render(ctx) {
    const l = lesson(ctx.params.id);
    if (!l) return notFound(t('lesson.notFound'), '#/');
    const s = student(l.student_id);
    const now = Date.now();
    const given = state.homework.filter((h) => h.lesson_id === l.id);
    const stillOpen = state.homework.filter((h) => h.student_id === l.student_id && h.status === 'open' && h.lesson_id !== l.id);

    return html`
      ${pageHeader({ back: '#/', right: html`<a class="btn small" href="#/lesson/${l.id}/edit">${icon('edit')} ${t('common.edit')}</a>` })}

      <section class="card lesson-hero is-${l.status}">
        <div class="hero-when">${cap(fmtDayLong(l.start_at))}</div>
        <div class="hero-time">${fmtTime(l.start_at)}<span>–${fmtTime(lessonEnd(l))}</span></div>
        <div class="hero-name">${s?.name ?? t('common.unknownStudent')}</div>
        <div class="hero-sub">${[s?.subject, s?.grade_level, l.topic].filter(Boolean).join(' · ')}</div>
        <div class="hero-badges">
          ${l.status === 'scheduled' ? html`<span class="badge accent">${icon('clock')} ${timing(l, now)}</span>` : ''}
          ${lessonBadges(l)}
          ${l.series_id ? html`<span class="badge">${icon('repeat')} ${t('repeat.badge')}</span>` : ''}
        </div>
        ${s ? html`<a class="hero-student" href="#/student/${s.id}">${avatar(s)}<span>${t('lesson.profile', { name: firstName(s.name) })}</span>${icon('chevronRight')}</a>` : ''}
      </section>

      ${l.status === 'scheduled'
        ? scheduledSections(l, now)
        : html`
            <section class="card pad status-banner">
              <span>${t(l.status === 'completed' ? 'lesson.isCompleted' : 'lesson.isCancelled')}</span>
              <button type="button" class="btn small" data-action="reopen">${icon('undo')} ${t('lesson.reopen')}</button>
            </section>`}

      <section class="card pad">
        <div class="card-title-row">
          <h2 class="card-title">${icon('money')} ${t('lesson.payment')}</h2>
          ${l.price > 0 ? html`<strong class="amount">${fmtMoney(l.price)}</strong>` : ''}
        </div>
        ${l.price > 0
          ? html`<button type="button" class="btn block ${l.paid ? 'success-soft' : ''}" data-action="toggle-paid">
              ${l.paid ? html`${icon('check')} ${l.paid_at ? t('lesson.paidOn', { date: fmtDay(l.paid_at) }) : t('common.paid')}` : t('lesson.markPaid')}
            </button>`
          : html`<p class="muted small">${t('lesson.noPrice')} <a href="#/lesson/${l.id}/edit">${t('lesson.addPrice')}</a></p>`}
      </section>

      <section class="card pad">
        <h2 class="card-title">${icon('book')} ${t('lesson.notes')}</h2>
        <form data-form="notes" class="stack">
          <textarea name="notes" rows="3" placeholder="${t('lesson.notesPlaceholder')}">${l.notes ?? ''}</textarea>
          <button class="btn small align-start" type="submit">${t('lesson.saveNotes')}</button>
        </form>
      </section>

      <section class="card pad">
        <h2 class="card-title">${icon('clipboard')} ${t('lesson.homework')}</h2>
        ${stillOpen.length ? html`<h3 class="sub-title">${t('lesson.stillOpen')}</h3><div class="list">${stillOpen.map((h) => homeworkRow(h))}</div>` : ''}
        <h3 class="sub-title">${t('lesson.givenHere')}</h3>
        ${given.length ? html`<div class="list">${given.map((h) => homeworkRow(h))}</div>` : html`<p class="muted small">${t('lesson.nothingYet')}</p>`}
        <form data-form="add-homework" class="inline-form">
          <input name="text" placeholder="${t('lesson.addHomeworkPlaceholder')}" required autocomplete="off" aria-label="${t('lesson.newHomeworkAria')}">
          <button class="btn primary" type="submit">${t('common.add')}</button>
        </form>
      </section>

      <button type="button" class="btn block danger-ghost" data-action="delete-lesson">${icon('trash')} ${t('lesson.delete')}</button>`;
  },
  mounted(root, ctx) {
    // Save notes automatically when you leave the box, so nothing typed gets lost.
    const box = root.querySelector('form[data-form=notes] textarea');
    box?.addEventListener('change', async () => {
      try {
        await updateRow('lessons', ctx.params.id, { notes: box.value });
        toast(t('lesson.notesSaved'));
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  },
  actions: lessonActions,
  forms: {
    async notes(form, ctx) {
      const { notes } = formValues(form);
      if ((lesson(ctx.params.id).notes ?? '') !== notes.trim()) await updateRow('lessons', ctx.params.id, { notes });
      toast(t('lesson.notesSaved'));
    },
    async 'add-homework'(form, ctx) {
      const l = lesson(ctx.params.id);
      const { text } = formValues(form);
      if (!text.trim()) return;
      await createRow('homework', { student_id: l.student_id, lesson_id: l.id, text });
      rerender();
      toast(t('hw.added'));
    },
  },
};
