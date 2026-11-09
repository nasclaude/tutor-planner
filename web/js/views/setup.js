// First launch: create the owner account with the SETUP_CODE secret.
import { html } from '../html.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { field } from '../components.js';
import { formValues } from '../ui.js';
import { languageSwitch, accountFields, readAccountFields, loggedIn } from './login.js';

export default {
  fullscreen: true,
  title: () => t('setup.title'),
  render() {
    return html`
      <div class="login">
        <img class="login-logo" src="icons/icon.svg" alt="" width="84" height="84">
        <h1>${t('setup.title')}</h1>
        <p class="muted">${t('setup.text')}</p>
        <form data-form="setup" class="card pad stack">
          ${field(t('setup.code'), html`<input name="code" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required aria-describedby="code-hint"><small class="hint" id="code-hint">${t('setup.codeHint')}</small>`)}
          ${accountFields()}
          <button class="btn primary block big" type="submit">${t('setup.submit')}</button>
        </form>
        ${languageSwitch()}
      </div>`;
  },
  forms: {
    async setup(form) {
      const account = readAccountFields(form);
      const { token } = await api('POST', '/api/setup', { code: formValues(form).code, ...account });
      loggedIn(token, { newAccount: true });
    },
  },
};
