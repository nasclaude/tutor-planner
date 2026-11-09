import { html } from '../html.js';
import { t, tn, cap } from '../i18n.js';
import { event, createRow, createSeries, updateRow, offsetsOf, notifies, reminderTimes } from '../store.js';
import { dateKey, timeKey, fromKeys, fmtMinutes, fmtTime, fmtDay, fmtDayMonth, fmtWeekdayLong } from '../time.js';
import { pageHeader, notFound, field, reminderPicker } from '../components.js';
import { go, toast, formValues } from '../ui.js';
import { repeatSheet } from '../actions.js';
import { nextFullHour, readReminderFields } from './lessonForm.js';

const LENGTHS = [null, 15, 30, 45, 60, 90, 120, 180];

export default {
  title: (ctx) => t(ctx.params.id ? 'event.edit' : 'event.new'),
  render(ctx) {
    const editing = ctx.params.id ? event(ctx.params.id) : null;
    if (ctx.params.id && !editing) return notFound(t('event.notFound'), '#/');
    const q = ctx.query;
    const start = editing?.start_at ?? (q.get('start') ? Number(q.get('start')) : nextFullHour());
    const length = editing?.duration_min ?? null;
    const lengths = [...new Set([...LENGTHS, length])];

    return html`
      ${pageHeader({ title: t(editing ? 'event.edit' : 'event.new'), back: editing ? `#/event/${editing.id}` : '#/' })}
      <form data-form="save" class="card pad stack">
        ${field(t('event.titleField'), html`<input name="title" value="${editing?.title ?? ''}" required maxlength="200" placeholder="${t('event.titlePlaceholder')}" autocomplete="off">`)}
        <div class="field-row">
          ${field(t('common.date'), html`<input type="date" name="date" value="${dateKey(start)}" required>`)}
          ${field(t('common.time'), html`<input type="time" name="time" value="${timeKey(start)}" required>`)}
        </div>
        ${field(
          t('common.length'),
          html`<select name="duration_min">${lengths.map(
            (m) => html`<option value="${m ?? ''}" ${String(length ?? '') === String(m ?? '') ? 'selected' : ''}>${m ? fmtMinutes(m) : t('event.lengthNone')}</option>`,
          )}</select>`,
          true,
        )}
        ${field(t('event.note'), html`<textarea name="note" rows="4" placeholder="${t('event.notePlaceholder')}">${editing?.note ?? ''}</textarea>`, true)}
        <div class="form-section">
          ${reminderPicker({ table: 'events', on: editing ? !!editing.reminders_on : true, offsets: editing ? offsetsOf(editing) : [0] })}
        </div>
        <button class="btn primary block big" type="submit">${t(editing ? 'common.saveChanges' : 'event.add')}</button>
      </form>`;
  },
  forms: {
    async save(form, ctx) {
      const editing = ctx.params.id ? event(ctx.params.id) : null;
      const v = formValues(form);
      const data = {
        title: v.title,
        start_at: fromKeys(v.date, v.time),
        duration_min: v.duration_min === '' ? null : Number(v.duration_min),
        note: v.note,
        ...readReminderFields(v),
      };
      const firstNotification = (row) => (notifies(row) ? reminderTimes(row).find((at) => at > Date.now()) : null);
      if (editing) {
        const row = await updateRow('events', editing.id, data);
        go(`#/event/${row.id}`, { replace: true });
        const next = firstNotification(row);
        toast(next ? `${t('event.updated')} · ${t('event.notifyAt', { time: fmtTime(next) })}` : t('event.updated'));
        return;
      }
      // A new reminder: once, or repeating (e.g. on the 1st of every month for a year)?
      repeatSheet({
        table: 'events',
        start: data.start_at,
        summary: `${cap(fmtWeekdayLong(data.start_at))}, ${fmtDayMonth(data.start_at)} · ${fmtTime(data.start_at)} · ${data.title}`,
        async onPick(starts) {
          const rows = starts.length === 1 ? [await createRow('events', data)] : await createSeries('events', starts.map((s) => ({ ...data, start_at: s })));
          go(`#/event/${rows[0].id}`, { replace: true });
          if (rows.length > 1) {
            toast(t('repeat.added', { count: tn('n.reminders', rows.length), date: fmtDay(rows[rows.length - 1].start_at) }));
            return;
          }
          const next = firstNotification(rows[0]);
          toast(next ? `${t('event.added')} · ${t('event.notifyAt', { time: fmtTime(next) })}` : t('event.added'));
        },
      });
    },
  },
};
