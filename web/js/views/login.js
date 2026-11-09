import { html } from '../html.js';
import { api, auth } from '../api.js';
import { t, getLang, LANGUAGES } from '../i18n.js';
import { field } from '../components.js';
import { formValues } from '../ui.js';

export function languageSwitch() {
  return html`
    <div class="lang-switch" role="group" aria-label="Language / Език">
      ${LANGUAGES.map(
        ([code, label]) => html`<button type="button" class="${getLang() === code ? 'active' : ''}" aria-pressed="${getLang() === code ? 'true' : 'false'}" data-action="set-lang" data-lang="${code}">${label}</button>`,
      )}
    </div>`;
}

// Name, username and password (twice) for a new account: used by first-time setup and by joining.
export function accountFields() {
  return html`
    ${field(t('account.name'), html`<input name="name" autocomplete="name" maxlength="80" required>`)}
    ${field(t('account.username'), html`<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="3" maxlength="32" pattern="[A-Za-z0-9._\\-]+" required aria-describedby="username-hint"><small class="hint" id="username-hint">${t('account.usernameHint')}</small>`)}
    ${field(t('account.password'), html`<input type="password" name="password" autocomplete="new-password" minlength="8" required aria-describedby="password-hint"><small class="hint" id="password-hint">${t('account.passwordHint')}</small>`)}
    ${field(t('account.passwordAgain'), html`<input type="password" name="password2" autocomplete="new-password" minlength="8" required>`)}`;
}

export function readAccountFields(form) {
  const v = formValues(form);
  if (v.password !== v.password2) throw new Error(t('account.mismatch'));
  return { name: v.name, username: v.username, password: v.password };
}

export const loggedIn = (token, { newAccount = false } = {}) => {
  auth.set(token);
  window.dispatchEvent(new CustomEvent('tp:login', { detail: { newAccount } }));
};

export default {
  fullscreen: true,
  title: () => t('login.title'),
  render() {
    return html`
      <div class="login">
        <img class="login-logo" src="icons/icon.svg" alt="" width="84" height="84">
        <h1>Tutor Planner</h1>
        <p class="muted">${t('login.tagline')}</p>
        <form data-form="login" class="card pad stack">
          ${field(t('login.username'), html`<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>`)}
          ${field(t('login.password'), html`<input type="password" name="password" autocomplete="current-password" required>`)}
          <button class="btn primary block big" type="submit">${t('login.submit')}</button>
        </form>
        <p class="small">${t('login.haveInvite')} <a href="#/join">${t('login.join')}</a></p>
        ${languageSwitch()}
      </div>`;
  },
  forms: {
    async login(form) {
      const v = formValues(form);
      const { token } = await api('POST', '/api/login', { username: v.username, password: v.password });
      loggedIn(token);
    },
  },
};
