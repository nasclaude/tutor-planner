import { html } from '../html.js';
import { icon } from '../icons.js';
import { t, cap } from '../i18n.js';
import { event, eventEnd, offsetsOf, updateRow } from '../store.js';
import { fmtTime, fmtDayLong, fmtRelative } from '../time.js';
import { pageHeader, notFound, reminderPicker, reminderSummary, noPhoneWarning, moveChips } from '../components.js';
import { eventActions } from '../actions.js';
import { toast, formValues } from '../ui.js';

export default {
  title: (ctx) => event(ctx.params.id)?.title ?? t('event.kind'),
  render(ctx) {
    const e = event(ctx.params.id);
    if (!e) return notFound(t('event.notFound'), '#/');
    const now = Date.now();
    const scheduled = e.status === 'scheduled';

    return html`
      ${pageHeader({ back: '#/', right: html`<a class="btn small" href="#/event/${e.id}/edit">${icon('edit')} ${t('common.edit')}</a>` })}

      <section class="card lesson-hero event-hero is-${e.status}">
        <div class="hero-kind">${icon('bell')} ${t('event.kind')}</div>
        <div class="hero-when">${cap(fmtDayLong(e.start_at))}</div>
        <div class="hero-time">${fmtTime(e.start_at)}${e.duration_min ? html`<span>–${fmtTime(eventEnd(e))}</span>` : ''}</div>
        <div class="hero-name">${e.title}</div>
        <div class="hero-badges">
          ${{
            scheduled: html`<span class="badge accent">${icon('clock')} ${fmtRelative(e.start_at, now)}</span>`,
            completed: html`<span class="badge success">${icon('check')} ${t('event.isDone')}</span>`,
            cancelled: html`<span class="badge muted">${t('event.badgeCancelled')}</span>`,
          }[e.status]}
          ${e.series_id ? html`<span class="badge">${icon('repeat')} ${t('repeat.badge')}</span>` : ''}
        </div>
      </section>

      ${scheduled
        ? html`
            <div class="action-pair">
              <button type="button" class="btn success big" data-action="complete">${icon('check')} ${t('event.doneBtn')}</button>
              <button type="button" class="btn danger-soft big" data-action="cancel">${icon('x')} ${t('event.cancelBtn')}</button>
            </div>`
        : html`
            <section class="card pad status-banner">
              <span>${t(e.status === 'completed' ? 'event.isCompleted' : 'event.isCancelled')}</span>
              <button type="button" class="btn small" data-action="reopen">${icon('undo')} ${t('lesson.reopen')}</button>
            </section>`}

      <section class="card pad">
        <h2 class="card-title">${icon('book')} ${t('event.note')}</h2>
        <form data-form="note" class="stack">
          <textarea name="note" rows="4" placeholder="${t('event.notePlaceholder')}">${e.note ?? ''}</textarea>
          <button class="btn small align-start" type="submit">${t('event.saveNote')}</button>
        </form>
      </section>

      ${scheduled
        ? html`
            <section class="card pad">
              <h2 class="card-title">${icon('clock')} ${t('event.moveCard')}</h2>
              ${moveChips()}
            </section>
            <section class="card pad">
              ${reminderPicker({ table: 'events', id: e.id, on: !!e.reminders_on, offsets: offsetsOf(e), live: true })}
              ${reminderSummary(e, now)}
              ${e.reminders_on ? noPhoneWarning() : ''}
            </section>`
        : ''}

      <button type="button" class="btn block danger-ghost" data-action="delete-event">${icon('trash')} ${t('event.delete')}</button>`;
  },
  mounted(root, ctx) {
    // Save the note automatically when you leave the box, so nothing typed gets lost.
    const box = root.querySelector('form[data-form=note] textarea');
    box?.addEventListener('change', async () => {
      try {
        await updateRow('events', ctx.params.id, { note: box.value });
        toast(t('event.noteSaved'));
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  },
  actions: eventActions,
  forms: {
    async note(form, ctx) {
      const { note } = formValues(form);
      if ((event(ctx.params.id).note ?? '') !== note.trim()) await updateRow('events', ctx.params.id, { note });
      toast(t('event.noteSaved'));
    },
  },
};
