import { html } from '../html.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { t, tn, th } from '../i18n.js';
import { state, saveSettings } from '../store.js';
import { fmtMinutes, fmtOffset, fmtDay, dateKey } from '../time.js';
import { pageHeader, field, avatar, APP_VERSION } from '../components.js';
import { toast, rerender, openSheet, confirmSheet, formValues } from '../ui.js';
import { pushEnvironment, currentSubscription, enablePush, disablePush, sendTestPush, updateAppBadge } from '../push.js';
import { languageSwitch } from './login.js';
import { prettyCode } from './join.js';

const OFFSET_CHOICES = [1440, 240, 180, 120, 60, 30, 15];
// Morning summary times: 05:00, 05:30 … 12:00.
const SUMMARY_TIMES = Array.from({ length: 15 }, (_, i) => `${String(5 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const strong = (text) => html`<strong>${text}</strong>`;

async function renderPushStatus(el) {
  const env = pushEnvironment();
  let content;
  if (env.ios && !env.standalone) {
    content = html`
      <p>${t('settings.iosIntro')}</p>
      <ol class="steps">
        <li>${th('settings.iosStep1', { safari: strong('Safari') })}</li>
        <li>${th('settings.iosStep2', { share: strong(t('settings.iosShare')), icon: icon('share') })}</li>
        <li>${th('settings.iosStep3', { add: strong(t('settings.iosAddToHome')) })}</li>
        <li>${th('settings.iosStep4', { app: strong('Tutor') })}</li>
      </ol>`;
  } else if (!env.supported) {
    content = html`<p class="muted small">${t('settings.unsupported')}</p>`;
  } else if (env.permission === 'denied') {
    content = html`<p class="warn small">${icon('alert')} ${th('settings.blocked', { path: strong(t('settings.blockedPath')) })}</p>`;
  } else {
    const sub = await currentSubscription().catch(() => null);
    content =
      sub && env.permission === 'granted'
        ? html`
            <p class="ok">${icon('check')} ${t('settings.on')}</p>
            <div class="btn-row">
              <button type="button" class="btn" data-action="push-test">${t('settings.sendTest')}</button>
              <button type="button" class="btn ghost" data-action="push-disable">${t('settings.turnOff')}</button>
            </div>`
        : html`
            <p class="muted small">${t('settings.offText')}</p>
            <button type="button" class="btn primary" data-action="push-enable">${icon('bell')} ${t('settings.turnOn')}</button>`;
  }
  const devices = state.devices ? html`<p class="muted small devices">${tn('settings.devices', state.devices)}</p>` : '';
  el.innerHTML = String(html`${content}${devices}`);
}

async function shareOrDownload(filename, text) {
  const file = new File([text], filename, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: t('settings.backupTitle') });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- People (only the owner sees this) ----------

const inviteLink = (code) => `${location.origin}${location.pathname}#/join/${code}`;

async function shareInvite(code) {
  const url = inviteLink(code);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Tutor Planner', text: t('people.shareMessage', { url, code: prettyCode(code) }) });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  await navigator.clipboard?.writeText(url).catch(() => {});
  toast(t('people.copied'));
}

function showInvite(invite) {
  const url = inviteLink(invite.code);
  openSheet({
    title: t('people.inviteReady'),
    body: html`
      <p class="sheet-text">${t('people.inviteText', { date: fmtDay(invite.expires_at) })}</p>
      <div class="big-code">${prettyCode(invite.code)}</div>
      <input class="invite-link" value="${url}" readonly aria-label="${t('people.copy')}">
      <div class="repeat-options">
        <button type="button" class="btn block big primary" data-sheet-action="share">${icon('share')} ${t('people.share')}</button>
        <button type="button" class="btn block big" data-sheet-action="copy">${t('people.copy')}</button>
      </div>`,
    submitLabel: null,
    actions: {
      async share() {
        await shareInvite(invite.code);
        return false;
      },
      async copy() {
        await navigator.clipboard?.writeText(url).catch(() => {});
        toast(t('people.copied'));
        return false;
      },
    },
  });
}

function peopleList(users, invites) {
  return html`
    <div class="list">
      ${users.map((u) => {
        const self = u.id === state.me?.id;
        const inner = html`
          ${avatar(u)}
          <div class="row-main">
            <div class="row-title">${u.name}${self ? ` (${t('people.you')})` : ''}</div>
            <div class="row-sub">@${u.username} · ${u.is_admin ? t('people.owner') : t('people.joined', { date: fmtDay(u.created_at) })}</div>
          </div>`;
        return self
          ? html`<div class="row">${inner}</div>`
          : html`<button type="button" class="row" data-action="person" data-id="${u.id}" data-name="${u.name}">${inner}${icon('chevronRight')}</button>`;
      })}
    </div>
    ${invites.length
      ? html`
          <h3 class="sub-title">${t('people.pending')}</h3>
          <div class="list">
            ${invites.map(
              (i) => html`
                <div class="row compact">
                  <div class="row-main">
                    <div class="row-title">${prettyCode(i.code)}${i.note ? ` · ${i.note}` : ''}</div>
                    <div class="row-sub">${t('people.expires', { date: fmtDay(i.expires_at) })}</div>
                  </div>
                  <button type="button" class="icon-btn" data-action="share-invite" data-code="${i.code}" aria-label="${t('people.share')}">${icon('share')}</button>
                  <button type="button" class="btn small ghost" data-action="cancel-invite" data-code="${i.code}">${t('people.cancelInvite')}</button>
                </div>`,
            )}
          </div>`
      : ''}`;
}

async function loadPeople(el) {
  if (!el) return;
  try {
    const { users, invites } = await api('GET', '/api/admin/people');
    el.innerHTML = String(peopleList(users, invites));
  } catch (err) {
    el.innerHTML = String(html`<p class="warn small">${err.message}</p>`);
  }
}

export default {
  tab: 'settings',
  title: () => t('settings.title'),
  render() {
    const { reminder_offsets: offsets, default_duration: duration, currency, timezone } = state.settings;
    const durations = [...new Set([30, 45, 60, 90, 120, duration])].sort((a, b) => a - b);
    const sorted = [...offsets].sort((a, b) => b - a);
    const summaryAt = state.settings.daily_summary || '';
    const summaryTimes = summaryAt && !SUMMARY_TIMES.includes(summaryAt) ? [...SUMMARY_TIMES, summaryAt].sort() : SUMMARY_TIMES;
    const badgeOn = state.settings.app_badge !== false;
    return html`
      ${pageHeader({ title: t('settings.title') })}

      ${state.me
        ? html`
            <section class="card pad stack">
              <h2 class="card-title">${icon('user')} ${t('settings.account')}</h2>
              <p>${t('settings.loggedInAs', { name: state.me.name, username: state.me.username })}</p>
              <button type="button" class="btn align-start" data-action="change-password">${icon('key')} ${t('settings.changePassword')}</button>
            </section>`
        : ''}

      ${state.me?.is_admin
        ? html`
            <section class="card pad stack">
              <h2 class="card-title">${icon('users')} ${t('people.title')}</h2>
              <p class="muted small">${t('people.text')}</p>
              <div data-people><p class="muted small">${t('common.loading')}…</p></div>
              <button type="button" class="btn primary align-start" data-action="invite">${icon('plus')} ${t('people.invite')}</button>
            </section>`
        : ''}

      <section class="card pad">
        <h2 class="card-title">${icon('globe')} ${t('settings.language')}</h2>
        ${languageSwitch()}
      </section>

      <section class="card pad">
        <h2 class="card-title">${icon('bell')} ${t('settings.notifications')}</h2>
        <div data-push-status><p class="muted small">${t('settings.checking')}</p></div>
      </section>

      <section class="card pad stack" data-summary-card>
        <h2 class="card-title">${icon('sun')} ${t('summary.title')}</h2>
        <p class="muted small">${t('summary.text')}</p>
        ${field(
          t('summary.time'),
          html`<select name="daily_summary" data-setting>
            <option value="" ${summaryAt ? '' : 'selected'}>${t('summary.off')}</option>
            ${summaryTimes.map((tm) => html`<option value="${tm}" ${tm === summaryAt ? 'selected' : ''}>${tm}</option>`)}
          </select>`,
        )}
        <button type="button" class="btn align-start" data-action="summary-now">${t('summary.sendNow')}</button>
        <div class="setting-row">
          <div>
            <strong>${t('appBadge.title')}</strong>
            <p class="muted small">${t('appBadge.text')}</p>
          </div>
          <button type="button" class="switch ${badgeOn ? 'on' : ''}" role="switch" aria-checked="${badgeOn ? 'true' : 'false'}"
            aria-label="${t('appBadge.title')}" data-action="toggle-badge"><span></span></button>
        </div>
      </section>

      <section class="card pad">
        <h2 class="card-title">${icon('clock')} ${t('settings.whenTitle')}</h2>
        <p class="muted small">${t('settings.whenText')}</p>
        <div class="chips spaced">
          ${OFFSET_CHOICES.map(
            (o) => html`<button type="button" class="chip ${offsets.includes(o) ? 'on' : ''}" aria-pressed="${offsets.includes(o) ? 'true' : 'false'}" data-action="toggle-offset" data-offset="${o}">${fmtOffset(o)}</button>`,
          )}
        </div>
        <p class="small">${sorted.length ? t('settings.whenSummary', { list: sorted.map(fmtOffset).join(', ') }) : t('settings.whenNone')}</p>
      </section>

      <section class="card pad stack">
        <h2 class="card-title">${icon('book')} ${t('settings.lessonsMoney')}</h2>
        <div class="field-row">
          ${field(t('settings.usualLength'), html`<select name="default_duration" data-setting>${durations.map((d) => html`<option value="${d}" ${d === duration ? 'selected' : ''}>${fmtMinutes(d)}</option>`)}</select>`)}
          ${field(t('settings.currency'), html`<input name="currency" value="${currency}" maxlength="8" data-setting autocomplete="off">`)}
        </div>
      </section>

      <section class="card pad stack">
        <h2 class="card-title">${icon('download')} ${t('settings.backup')}</h2>
        <p class="muted small">${t('settings.backupText')}</p>
        <button type="button" class="btn align-start" data-action="backup">${icon('download')} ${t('settings.download')}</button>
      </section>

      <button type="button" class="btn block danger-ghost" data-action="logout">${icon('logout')} ${t('settings.logout')}</button>
      <p class="muted small center footer-note">${t('settings.footer', { v: APP_VERSION, tz: timezone })}</p>`;
  },
  mounted(root) {
    renderPushStatus(root.querySelector('[data-push-status]'));
    loadPeople(root.querySelector('[data-people]'));
    for (const input of root.querySelectorAll('[data-setting]')) {
      input.addEventListener('change', async () => {
        try {
          const value = input.name === 'default_duration' ? Number(input.value) : input.value;
          await saveSettings({ [input.name]: value });
          toast(t('common.saved'));
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    }
  },
  actions: {
    async 'toggle-offset'(el) {
      const offset = Number(el.dataset.offset);
      const current = state.settings.reminder_offsets;
      const next = current.includes(offset) ? current.filter((o) => o !== offset) : [...current, offset];
      await saveSettings({ reminder_offsets: next });
      rerender();
    },
    async 'push-enable'() {
      await enablePush();
      rerender();
      toast(t('settings.toastOn'));
    },
    async 'push-disable'() {
      await disablePush();
      rerender();
      toast(t('settings.toastOff'));
    },
    async 'summary-now'() {
      const result = await sendTestPush('summary');
      if (result.sent) toast(t('summary.sent'));
      else toast(t('settings.testRefused', { status: result.errors?.[0]?.status ?? '?', error: result.errors?.[0]?.error || '—' }), { error: true });
    },
    async 'toggle-badge'() {
      await saveSettings({ app_badge: state.settings.app_badge === false });
      rerender();
      updateAppBadge();
    },
    async 'push-test'() {
      const result = await sendTestPush();
      if (result.sent) toast(t('settings.testSent'));
      else toast(t('settings.testRefused', { status: result.errors?.[0]?.status ?? '?', error: result.errors?.[0]?.error || '—' }), { error: true });
    },
    async backup() {
      const { students, lessons, grades, homework, events, settings } = state;
      const data = { app: 'tutor-planner', exported_at: new Date().toISOString(), students, lessons, grades, homework, events, settings };
      await shareOrDownload(`tutor-planner-backup-${dateKey(Date.now())}.json`, JSON.stringify(data, null, 2));
    },
    invite() {
      openSheet({
        title: t('people.invite'),
        body: field(t('people.inviteNote'), html`<input name="note" maxlength="80" placeholder="${t('people.inviteNotePlaceholder')}" autocomplete="off">`, true),
        submitLabel: t('people.create'),
        async onSubmit(form) {
          const invite = await api('POST', '/api/admin/invites', { note: formValues(form).note });
          rerender();
          showInvite(invite);
        },
      });
    },
    'share-invite': (el) => shareInvite(el.dataset.code),
    async 'cancel-invite'(el) {
      await api('DELETE', `/api/admin/invites/${el.dataset.code}`);
      rerender();
      toast(t('people.inviteCancelled'));
    },
    person(el) {
      const { id, name } = el.dataset;
      openSheet({
        title: name,
        body: html`
          <div class="repeat-options">
            <button type="button" class="btn block big" data-sheet-action="reset">${icon('key')} ${t('people.resetButton')}</button>
            <button type="button" class="btn block big danger-soft" data-sheet-action="remove">${icon('trash')} ${t('people.removeButton')}</button>
          </div>`,
        submitLabel: null,
        actions: {
          async reset() {
            const ok = await confirmSheet({ title: t('people.resetButton'), message: t('people.resetText', { name }), confirmLabel: t('people.resetButton') });
            if (!ok) return;
            const { tempPassword } = await api('POST', `/api/admin/users/${id}/reset-password`, {});
            openSheet({
              title: t('people.tempTitle'),
              body: html`<p class="sheet-text">${t('people.tempText', { name })}</p><div class="big-code">${tempPassword}</div>`,
              submitLabel: t('people.close'),
            });
          },
          async remove() {
            const ok = await confirmSheet({ title: t('people.removeTitle', { name }), message: t('people.removeText'), confirmLabel: t('people.removeButton'), danger: true });
            if (!ok) return;
            await api('DELETE', `/api/admin/users/${id}`);
            rerender();
            toast(t('people.removed', { name }));
          },
        },
      });
    },
  },
};
