// Things you can do to lessons, planner reminders, homework and payments, shared by several screens.
import { html } from './html.js';
import { icon } from './icons.js';
import { t, tn } from './i18n.js';
import {
  state, lesson, event, student, updateRow, createRow, deleteRow, findOverlap, unpaidLessons, offsetsOf, notifies, seriesFrom, loadData,
} from './store.js';
import { openSheet, confirmSheet, toast, rerender, go, nav, formValues } from './ui.js';
import { api, auth } from './api.js';
import { disablePush } from './push.js';
import { fmtTime, fmtWhen, addDays, dateKey, timeKey, fromKeys, repeatStarts, MINUTE } from './time.js';
import { fmtMoney, field } from './components.js';

const ITEMS = { lessons: lesson, events: event };

function undoable(message, undo) {
  toast(message, {
    action: t('common.undo'),
    onAction: async () => {
      await undo();
      rerender();
    },
  });
}

const who = (l) => student(l.student_id)?.name ?? t('lesson.title');

// ---------- lessons ----------

export function completeLesson(id) {
  const l = lesson(id);
  openSheet({
    title: t('lesson.completeTitle'),
    body: html`
      <p class="sheet-text">${who(l)} · ${fmtWhen(l.start_at)}</p>
      ${field(t('lesson.whatCovered'), html`<textarea name="notes" rows="3" placeholder="${t('lesson.coveredPlaceholder')}">${l.notes ?? ''}</textarea>`, true)}
      ${field(t('lesson.homeworkNext'), html`<textarea name="homework" rows="2" placeholder="${t('hw.placeholder')}"></textarea>`, true)}
      <div class="field-row align-end">
        ${field(t('common.price'), html`<input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${l.price ?? ''}" placeholder="—">`)}
        <label class="check"><input type="checkbox" name="paid" ${l.paid ? 'checked' : ''}> ${t('common.paid')}</label>
      </div>`,
    submitLabel: t('lesson.markCompleted'),
    submitClass: 'success',
    async onSubmit(form) {
      const v = formValues(form);
      const before = { status: l.status, notes: l.notes, price: l.price, paid: l.paid };
      await updateRow('lessons', id, { status: 'completed', notes: v.notes, price: v.price === '' ? null : Number(v.price), paid: v.paid });
      if (v.homework.trim()) await createRow('homework', { student_id: l.student_id, lesson_id: id, text: v.homework });
      rerender();
      undoable(t('lesson.toastCompleted'), () => updateRow('lessons', id, before));
    },
  });
}

export async function cancelLesson(id) {
  const l = lesson(id);
  const ok = await confirmSheet({
    title: t('lesson.cancelTitle'),
    message: t('lesson.cancelText', { who: who(l), when: fmtWhen(l.start_at) }),
    confirmLabel: t('lesson.cancelBtn'),
    danger: true,
  });
  if (!ok) return;
  const before = l.status;
  await updateRow('lessons', id, { status: 'cancelled' });
  rerender();
  undoable(t('lesson.toastCancelled'), () => updateRow('lessons', id, { status: before }));
}

// The tick circle on Today: one tap marks a lesson completed, another puts it back.
export async function toggleLessonDone(id) {
  const before = lesson(id).status;
  const done = before === 'completed';
  await updateRow('lessons', id, { status: done ? 'scheduled' : 'completed' });
  rerender();
  undoable(t(done ? 'lesson.toastReopened' : 'lesson.toastCompleted'), () => updateRow('lessons', id, { status: before }));
}

export async function reopenLesson(id) {
  const before = lesson(id).status;
  await updateRow('lessons', id, { status: 'scheduled' });
  rerender();
  undoable(t('lesson.toastReopened'), () => updateRow('lessons', id, { status: before }));
}

export async function togglePaid(id) {
  const wasPaid = !!lesson(id).paid;
  await updateRow('lessons', id, { paid: !wasPaid });
  rerender();
  undoable(t(wasPaid ? 'lesson.toastUnpaid' : 'lesson.toastPaid'), () => updateRow('lessons', id, { paid: wasPaid }));
}

export async function deleteLesson(id) {
  const l = lesson(id);
  const s = student(l.student_id);
  const choice = await chooseDelete('lessons', l, {
    title: t('lesson.deleteTitle'),
    message: t('lesson.deleteText', { who: who(l), when: fmtWhen(l.start_at) }),
  });
  if (!choice) return;
  const count = await deleteRow('lessons', id, { following: choice === 'following' });
  go(s ? `#/student/${s.id}/lessons` : '#/', { replace: true });
  toast(count > 1 ? t('repeat.deletedMany', { count: countOf('lessons', count) }) : t('lesson.toastDeleted'));
}

// ---------- moving lessons and planner reminders ----------

export function shiftedStart(item, kind) {
  if (kind === 'tomorrow') return addDays(item.start_at, 1);
  if (kind === 'week') return addDays(item.start_at, 7);
  return item.start_at + Number(kind) * MINUTE;
}

export async function moveItem(table, id, start) {
  const item = ITEMS[table](id);
  if (table === 'lessons') {
    const clash = findOverlap(start, item.duration_min, id);
    if (clash) {
      const ok = await confirmSheet({
        title: t('common.timeClash'),
        message: t('lesson.clashMove', { name: who(clash), time: fmtTime(clash.start_at) }),
        confirmLabel: t('common.moveAnyway'),
      });
      if (!ok) return;
    }
  }
  const before = item.start_at;
  const row = await updateRow(table, id, { start_at: start });
  rerender();
  const message = t(table === 'lessons' ? 'lesson.toastMoved' : 'event.toastMoved', { when: fmtWhen(start) });
  const updated = notifies(row) && row.start_at > Date.now();
  undoable(updated ? `${message} · ${t('common.remindersUpdated')}` : message, () => updateRow(table, id, { start_at: before }));
}

export function pickNewTime(table, id) {
  const item = ITEMS[table](id);
  openSheet({
    title: t(table === 'lessons' ? 'lesson.moveTitle' : 'event.moveCard'),
    body: html`
      <div class="field-row">
        ${field(t('common.date'), html`<input type="date" name="date" value="${dateKey(item.start_at)}" required>`)}
        ${field(t('common.time'), html`<input type="time" name="time" value="${timeKey(item.start_at)}" required>`)}
      </div>`,
    submitLabel: t(table === 'lessons' ? 'lesson.moveTitle' : 'event.moveCard'),
    async onSubmit(form) {
      const { date, time } = formValues(form);
      const start = fromKeys(date, time);
      if (start !== item.start_at) await moveItem(table, id, start);
    },
  });
}

// ---------- reminder switch and times (see reminderPicker) ----------

const defaultOffsets = (table) => (table === 'lessons' ? [...state.settings.reminder_offsets] : [0]);

// In a form nothing is saved yet: update the hidden fields and the look of the picker.
function updateFormPicker(picker, { toggle = false, offset = null }) {
  const onField = picker.querySelector('input[name=reminders_on]');
  const offsetsField = picker.querySelector('input[name=remind_offsets]');
  let on = onField.value === '1';
  let offsets = offsetsField.value ? offsetsField.value.split(',').map(Number) : [];
  if (toggle) {
    on = !on;
    if (on && !offsets.length) offsets = defaultOffsets(picker.dataset.table);
  }
  if (offset != null) {
    offsets = offsets.includes(offset) ? offsets.filter((o) => o !== offset) : [...offsets, offset];
    on = true; // picking a time means you want the reminder
  }
  onField.value = on ? '1' : '';
  offsetsField.value = offsets.join(',');
  picker.classList.toggle('is-off', !on);
  const sw = picker.querySelector('.switch');
  sw.classList.toggle('on', on);
  sw.setAttribute('aria-checked', String(on));
  picker.querySelector('[data-remind-title]').innerHTML = String(html`${icon(on ? 'bell' : 'bellOff')} ${t('remind.title')}`);
  for (const chip of picker.querySelectorAll('[data-offset]')) {
    const selected = offsets.includes(Number(chip.dataset.offset));
    chip.classList.toggle('on', selected);
    chip.setAttribute('aria-pressed', String(selected));
  }
}

async function remindSwitch(el) {
  const picker = el.closest('[data-remind-picker]');
  if (!picker.dataset.live) return updateFormPicker(picker, { toggle: true });
  const { table, id } = picker.dataset;
  const item = ITEMS[table](id);
  const patch = { reminders_on: !item.reminders_on };
  if (!item.reminders_on && !offsetsOf(item).length) patch.remind_offsets = defaultOffsets(table);
  // No toast: the switch shows the new state, and a toast would cover the time buttons below it.
  await updateRow(table, id, patch);
  rerender();
}

async function remindOffset(el) {
  const picker = el.closest('[data-remind-picker]');
  const offset = Number(el.dataset.offset);
  if (!picker.dataset.live) return updateFormPicker(picker, { offset });
  const { table, id } = picker.dataset;
  const current = offsetsOf(ITEMS[table](id));
  const next = current.includes(offset) ? current.filter((o) => o !== offset) : [...current, offset];
  await updateRow(table, id, { remind_offsets: next, reminders_on: true });
  rerender();
}

// ---------- planner reminders ----------

// Planner reminders have the same statuses as lessons: scheduled, completed (green) or cancelled (struck through).

// The tick circle: one tap marks it completed, another puts it back.
export async function toggleEventDone(id) {
  const before = event(id).status;
  const done = before === 'completed';
  await updateRow('events', id, { status: done ? 'scheduled' : 'completed' });
  rerender();
  undoable(t(done ? 'event.toastUndone' : 'event.toastDone'), () => updateRow('events', id, { status: before }));
}

export async function completeEvent(id) {
  const before = event(id).status;
  await updateRow('events', id, { status: 'completed' });
  rerender();
  undoable(t('event.toastDone'), () => updateRow('events', id, { status: before }));
}

export async function cancelEvent(id) {
  const e = event(id);
  const ok = await confirmSheet({
    title: t('event.cancelTitle'),
    message: t('event.cancelText', { title: e.title, when: fmtWhen(e.start_at) }),
    confirmLabel: t('event.cancelBtn'),
    danger: true,
  });
  if (!ok) return;
  const before = e.status;
  await updateRow('events', id, { status: 'cancelled' });
  rerender();
  undoable(t('event.toastCancelled'), () => updateRow('events', id, { status: before }));
}

export async function reopenEvent(id) {
  const before = event(id).status;
  await updateRow('events', id, { status: 'scheduled' });
  rerender();
  undoable(t('event.toastReopened'), () => updateRow('events', id, { status: before }));
}

export async function deleteEvent(id) {
  const e = event(id);
  const choice = await chooseDelete('events', e, {
    title: t('event.deleteTitle'),
    message: t('event.deleteText', { title: e.title, when: fmtWhen(e.start_at) }),
  });
  if (!choice) return;
  const count = await deleteRow('events', id, { following: choice === 'following' });
  go('#/', { replace: true });
  toast(count > 1 ? t('repeat.deletedMany', { count: countOf('events', count) }) : t('event.deleted'));
}

// "What would you like to add?" — a lesson or a planner reminder, optionally at a chosen time.
export function addMenu(start = null) {
  const q = start ? `?start=${start}` : '';
  openSheet({
    title: start ? t('add.titleAt', { when: fmtWhen(start) }) : t('add.title'),
    body: html`
      <div class="choices">
        <a class="choice" href="#/lesson/new${q}">
          <span class="choice-icon lesson">${icon('book')}</span>
          <span class="choice-text"><strong>${t('add.lesson')}</strong><small>${t('add.lessonText')}</small></span>
          ${icon('chevronRight')}
        </a>
        <a class="choice" href="#/event/new${q}">
          <span class="choice-icon event">${icon('bell')}</span>
          <span class="choice-text"><strong>${t('add.reminder')}</strong><small>${t('add.reminderText')}</small></span>
          ${icon('chevronRight')}
        </a>
      </div>`,
    submitLabel: null,
  });
}

// ---------- repeating lessons and reminders ----------

const EVERY = [
  ['week', 'repeat.weekly'],
  ['2weeks', 'repeat.biweekly'],
  ['month', 'repeat.monthly'],
];
const PERIODS = [3, 6, 12];
const countOf = (table, n) => tn(table === 'lessons' ? 'n.lessons' : 'n.reminders', n);

// Asked when a new lesson or reminder is added: just once, or repeat it for 3, 6 or 12 months.
// onPick(starts) creates the items (one per start time).
export function repeatSheet({ table, start, summary, onPick }) {
  let every = 'week';
  openSheet({
    title: t(table === 'lessons' ? 'repeat.titleLesson' : 'repeat.titleReminder'),
    body: html`
      <p class="sheet-text">${summary}</p>
      <button type="button" class="btn block big" data-sheet-action="once">${t('repeat.once')}</button>
      <div class="lang-switch" role="group" aria-label="${t('repeat.how')}">
        ${EVERY.map(
          ([key, label]) => html`<button type="button" class="${key === every ? 'active' : ''}" aria-pressed="${key === every ? 'true' : 'false'}" data-sheet-action="every" data-every="${key}">${t(label)}</button>`,
        )}
      </div>
      <div class="repeat-options">
        ${PERIODS.map(
          (months) => html`
            <button type="button" class="btn block big repeat-option" data-sheet-action="period" data-months="${months}">
              <span>${icon('repeat')} ${t('repeat.forMonths', { n: months })}</span>
              <small data-repeat-count="${months}">${countOf(table, repeatStarts(start, every, months).length)}</small>
            </button>`,
        )}
      </div>`,
    submitLabel: null,
    actions: {
      every(form, button) {
        every = button.dataset.every;
        for (const b of form.querySelectorAll('[data-every]')) {
          b.classList.toggle('active', b === button);
          b.setAttribute('aria-pressed', String(b === button));
        }
        for (const c of form.querySelectorAll('[data-repeat-count]')) {
          c.textContent = countOf(table, repeatStarts(start, every, Number(c.dataset.repeatCount)).length);
        }
        return false; // keep the sheet open
      },
      period: (form, button) => onPick(repeatStarts(start, every, Number(button.dataset.months))),
      once: () => onPick([start]),
    },
  });
}

// Before deleting: for an item of a repeating series, ask whether to delete just it or the later ones too.
// Resolves to 'one', 'following' or null (closed).
function chooseDelete(table, item, { title, message }) {
  const later = seriesFrom(table, item);
  if (later.length <= 1) {
    return confirmSheet({ title, message, confirmLabel: t('common.delete'), danger: true }).then((ok) => (ok ? 'one' : null));
  }
  return new Promise((resolve) => {
    openSheet({
      title,
      body: html`
        <p class="sheet-text">${message}</p>
        <p class="sheet-text">${t('repeat.deleteText')}</p>
        <div class="repeat-options">
          <button type="button" class="btn block big danger" data-sheet-action="one">${t('repeat.deleteOne')}</button>
          <button type="button" class="btn block big danger-soft" data-sheet-action="following">${t('repeat.deleteFollowing', { count: countOf(table, later.length) })}</button>
        </div>`,
      submitLabel: null,
      actions: { one: () => resolve('one'), following: () => resolve('following') },
      onClose: () => resolve(null),
    });
  });
}

// ---------- homework and payments ----------

// Add homework (h = null) or edit/delete an existing item.
export function homeworkSheet(studentId, h = null, lessonId = null) {
  openSheet({
    title: t(h ? 'hw.editTitle' : 'hw.addTitle'),
    body: html`
      ${field(t('hw.field'), html`<textarea name="text" rows="3" required placeholder="${t('hw.placeholder')}">${h?.text ?? ''}</textarea>`)}
      ${field(t('hw.dueDate'), html`<input type="date" name="due_date" value="${h?.due_date ?? ''}">`, true)}`,
    submitLabel: t(h ? 'common.save' : 'hw.add'),
    danger: h ? { label: t('common.delete'), action: 'delete' } : null,
    actions: {
      async delete() {
        await deleteRow('homework', h.id);
        rerender();
        toast(t('hw.deleted'));
      },
    },
    async onSubmit(form) {
      const v = formValues(form);
      const data = { text: v.text, due_date: v.due_date || null };
      if (h) await updateRow('homework', h.id, data);
      else await createRow('homework', { ...data, student_id: studentId, lesson_id: lessonId });
      rerender();
      toast(t(h ? 'hw.saved' : 'hw.added'));
    },
  });
}

export async function payAll(studentId) {
  const list = unpaidLessons(studentId);
  if (!list.length) return;
  const total = list.reduce((sum, l) => sum + l.price, 0);
  const ok = await confirmSheet({
    title: t('pay.allTitle'),
    message: t('pay.allText', { count: tn('n.lessons', list.length), name: student(studentId)?.name ?? '', amount: fmtMoney(total) }),
    confirmLabel: t('pay.allButton'),
  });
  if (!ok) return;
  for (const l of list) await updateRow('lessons', l.id, { paid: true });
  rerender();
  undoable(t('pay.toastAll', { amount: fmtMoney(total) }), async () => {
    for (const l of list) await updateRow('lessons', l.id, { paid: false });
  });
}

// ---------- your account ----------

export function changePasswordSheet() {
  openSheet({
    title: t('password.title'),
    body: html`
      ${field(t('password.current'), html`<input type="password" name="current" autocomplete="current-password" required>`)}
      ${field(t('password.new'), html`<input type="password" name="next" autocomplete="new-password" minlength="8" required>`)}
      ${field(t('password.newAgain'), html`<input type="password" name="again" autocomplete="new-password" minlength="8" required>`)}`,
    submitLabel: t('password.save'),
    async onSubmit(form) {
      const v = formValues(form);
      if (v.next !== v.again) throw new Error(t('account.mismatch'));
      const { token } = await api('POST', '/api/account/password', { current: v.current, next: v.next });
      auth.set(token);
      await loadData();
      rerender();
      toast(t('password.saved'));
    },
  });
}

// Logging out also stops this phone's notifications, so the next person using it never sees yours.
export async function logout() {
  await disablePush().catch(() => {});
  auth.clear();
  window.dispatchEvent(new CustomEvent('tp:logout'));
}

// ---------- action maps used by the screens ----------

const idOf = (el, ctx) => el.dataset.id || ctx.params?.id;

const moveActions = (table) => ({
  move: (el, ctx) => {
    const id = idOf(el, ctx);
    return moveItem(table, id, shiftedStart(ITEMS[table](id), el.dataset.kind));
  },
  'pick-time': (el, ctx) => pickNewTime(table, idOf(el, ctx)),
});

export const lessonActions = {
  ...moveActions('lessons'),
  complete: (el, ctx) => completeLesson(idOf(el, ctx)),
  cancel: (el, ctx) => cancelLesson(idOf(el, ctx)),
  reopen: (el, ctx) => reopenLesson(idOf(el, ctx)),
  'toggle-paid': (el, ctx) => togglePaid(idOf(el, ctx)),
  'delete-lesson': (el, ctx) => deleteLesson(idOf(el, ctx)),
};

export const eventActions = {
  ...moveActions('events'),
  complete: (el, ctx) => completeEvent(idOf(el, ctx)),
  cancel: (el, ctx) => cancelEvent(idOf(el, ctx)),
  reopen: (el, ctx) => reopenEvent(idOf(el, ctx)),
  'delete-event': (el, ctx) => deleteEvent(idOf(el, ctx)),
};

// Actions available on every screen.
export const sharedActions = {
  back(el) {
    if (nav.count > 0) history.back();
    else go(el.dataset.fallback || '#/', { replace: true });
  },
  'add-menu': () => addMenu(),
  'event-done': (el) => toggleEventDone(el.dataset.id),
  'lesson-done': (el) => toggleLessonDone(el.dataset.id),
  'remind-switch': remindSwitch,
  'remind-offset': remindOffset,
  async 'hw-status'(el) {
    const { id, status } = el.dataset;
    await updateRow('homework', id, { status });
    rerender();
    toast(t(status === 'done' ? 'hw.toastDone' : status === 'missed' ? 'hw.toastMissed' : 'hw.toastReopened'));
  },
  'edit-homework': (el) => homeworkSheet(null, state.homework.find((h) => h.id === el.dataset.id)),
  async pay(el) {
    const { id } = el.dataset;
    await updateRow('lessons', id, { paid: true });
    rerender();
    undoable(t('lesson.toastPaid'), () => updateRow('lessons', id, { paid: false }));
  },
  'pay-all': (el) => payAll(el.dataset.student),
  'change-password': () => changePasswordSheet(),
  logout: () => logout(),
};
