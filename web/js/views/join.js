// Joining with an invite from the owner: #/join or #/join/<code>.
import { html } from '../html.js';
import { api, auth } from '../api.js';
import { t } from '../i18n.js';
import { state } from '../store.js';
import { field } from '../components.js';
import { formValues } from '../ui.js';
import { languageSwitch, accountFields, readAccountFields, loggedIn } from './login.js';

// "K7QX3MPA" -> "K7QX-3MPA"
export const prettyCode = (code) => {
  const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

export default {
  fullscreen: true,
  title: () => t('join.title'),
  render(ctx) {
    if (auth.token) {
      return html`
        <div class="login">
          <h1>${t('join.title')}</h1>
          <p class="muted">${t('join.loggedIn', { name: state.me?.name ?? '' })}</p>
          <button type="button" class="btn primary big" data-action="logout">${t('settings.logout')}</button>
          <p class="small"><a href="#/">${t('common.back')}</a></p>
        </div>`;
    }
    return html`
      <div class="login">
        <img class="login-logo" src="icons/icon.svg" alt="" width="84" height="84">
        <h1>${t('join.title')}</h1>
        <p class="muted">${t('join.text')}</p>
        <form data-form="join" class="card pad stack">
          ${field(t('join.code'), html`<input name="code" value="${prettyCode(ctx.params.code)}" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" required>`)}
          ${accountFields()}
          <p class="muted small">${t('join.private')}</p>
          <button class="btn primary block big" type="submit">${t('join.submit')}</button>
        </form>
        <p class="small">${t('join.haveAccount')} <a href="#/">${t('login.submit')}</a></p>
        ${languageSwitch()}
      </div>`;
  },
  forms: {
    async join(form) {
      const account = readAccountFields(form);
      const { token } = await api('POST', '/api/join', { code: formValues(form).code, ...account });
      location.replace('#/');
      loggedIn(token, { newAccount: true });
    },
  },
};
