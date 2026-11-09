// Start-up, routing and event wiring.
import { html } from './html.js';
import { icon } from './icons.js';
import { auth, api } from './api.js';
import { t, getLang, setLang } from './i18n.js';
import { state, loadData, loadCached, resetState, saveSettings } from './store.js';
import { toast, clearToast, closeSheet, sheetOpen, nav } from './ui.js';
import { sharedActions } from './actions.js';
import { syncDevice } from './push.js';
import login from './views/login.js';
import setupView from './views/setup.js';
import joinView from './views/join.js';
import today from './views/today.js';
import week from './views/week.js';
import lessonView from './views/lesson.js';
import lessonForm from './views/lessonForm.js';
import eventView from './views/event.js';
import eventForm from './views/eventForm.js';
import students from './views/students.js';
import studentView from './views/student.js';
import studentForm from './views/studentForm.js';
import money from './views/money.js';
import settings from './views/settings.js';

const ROUTES = [
  [/^\/$/, today],
  [/^\/week(?:\/(\d{4}-\d{2}-\d{2}))?$/, week, ['date']],
  [/^\/lesson\/new$/, lessonForm],
  [/^\/lesson\/([\w-]+)\/edit$/, lessonForm, ['id']],
  [/^\/lesson\/([\w-]+)$/, lessonView, ['id']],
  [/^\/event\/new$/, eventForm],
  [/^\/event\/([\w-]+)\/edit$/, eventForm, ['id']],
  [/^\/event\/([\w-]+)$/, eventView, ['id']],
  [/^\/students$/, students],
  [/^\/student\/new$/, studentForm],
  [/^\/student\/([\w-]+)\/edit$/, studentForm, ['id']],
  [/^\/student\/([\w-]+)(?:\/(lessons|grades|homework))?$/, studentView, ['id', 'tab']],
  [/^\/money(?:\/(\d{4}-\d{2}))?$/, money, ['month']],
  [/^\/settings$/, settings],
  [/^\/join(?:\/([\w-]+))?$/, joinView, ['code']],
];

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
let current = { view: null, ctx: null, hash: null };

function parseHash() {
  const [path, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
  return { path: path || '/', query: new URLSearchParams(qs || '') };
}

function resolve(path) {
  for (const [pattern, view, names = []] of ROUTES) {
    const m = path.match(pattern);
    if (m) return { view, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) };
  }
  return null;
}

const splash = () => html`<div class="splash"><div class="spinner" role="status" aria-label="${t('common.loading')}"></div></div>`;
const errorScreen = (message) => html`
  <div class="splash">
    <div class="empty">
      <div class="empty-icon">${icon('wifiOff')}</div>
      <h2>${t('error.cantReach')}</h2>
      <p>${message}</p>
      <button type="button" class="btn primary" data-action="retry">${t('common.tryAgain')}</button>
    </div>
  </div>`;

// Tab bar labels live in index.html; translate them on every render.
function translateStatic() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function showChrome(visible) {
  tabbar.hidden = !visible;
  document.body.classList.toggle('no-tabbar', !visible);
}

function render() {
  translateStatic();
  const { path, query } = parseHash();
  let view;
  let params = {};
  if (!auth.token) {
    // Signed out: join with an invite, first-time setup of the owner account, or log in.
    const joining = path.match(/^\/join(?:\/([\w-]+))?$/);
    view = joining ? joinView : state.needsSetup ? setupView : login;
    if (joining) params = { code: joining[1] };
  } else if (!state.loaded) {
    app.innerHTML = String(state.error ? errorScreen(state.error) : splash());
    showChrome(false);
    current = { view: null, ctx: null, hash: null };
    return;
  } else {
    const match = resolve(path);
    if (!match) {
      location.replace('#/');
      return;
    }
    ({ view, params } = match);
  }

  const ctx = { params, query, path };
  const sameScreen = current.view === view && current.hash === location.hash;
  const scrollY = window.scrollY;
  current = { view, ctx, hash: location.hash };

  app.innerHTML = String(view.render(ctx));
  showChrome(!view.fullscreen);
  for (const a of tabbar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === view.tab);
  const title = typeof view.title === 'function' ? view.title(ctx) : view.title;
  document.title = title ? `${title} · Tutor Planner` : 'Tutor Planner';
  view.mounted?.(app, ctx);
  window.scrollTo(0, sameScreen ? scrollY : 0);
}

const isEditing = () => {
  const el = document.activeElement;
  return !!el && app.contains(el) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
};

// The language is stored on the server too (notifications use it). A choice made on the
// login screen wins once; otherwise the server's language is used on every device.
let languageChosenBeforeLogin = false;

async function refresh({ quiet = false } = {}) {
  if (!auth.token) return;
  try {
    await loadData();
    if (languageChosenBeforeLogin) {
      languageChosenBeforeLogin = false;
      if (state.settings.language !== getLang()) saveSettings({ language: getLang() }).catch(() => {});
    } else {
      setLang(state.settings.language);
    }
  } catch (err) {
    if (err.status === 401) return; // the logout event takes over
    if (state.loaded) {
      state.offline = true;
      if (!quiet) toast(t('error.offlineToast'));
    } else {
      state.error = err.message;
    }
  }
  if (!sheetOpen() && !isEditing()) render();
}

function afterLogin() {
  syncDevice().catch(() => {});
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (state.loaded && tz && state.settings.timezone !== tz) saveSettings({ timezone: tz }).catch(() => {});
}

async function checkSetup() {
  try {
    const before = state.needsSetup;
    state.needsSetup = !!(await api('GET', '/api/health')).needsSetup;
    if (state.needsSetup !== before && !auth.token) render();
  } catch {
    // offline or not configured yet: keep showing the login screen
  }
}

const appActions = {
  async 'set-lang'(el) {
    if (!setLang(el.dataset.lang)) return;
    clearToast();
    render();
    if (auth.token && state.loaded) await saveSettings({ language: getLang() });
    else languageChosenBeforeLogin = true;
  },
  retry() {
    state.error = null;
    render();
    refresh().then(afterLogin);
  },
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.closest('#sheet-root')) return;
  const name = el.dataset.action;
  const handler = current.view?.actions?.[name] ?? sharedActions[name] ?? appActions[name];
  if (!handler) return;
  ev.preventDefault();
  if (el.disabled) return;
  el.disabled = true;
  try {
    await handler(el, current.ctx ?? { params: {}, query: new URLSearchParams() }, ev);
  } catch (err) {
    toast(err.message || String(err), { error: true });
  } finally {
    el.disabled = false;
  }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form || form.closest('#sheet-root')) return;
  ev.preventDefault();
  const handler = current.view?.forms?.[form.dataset.form];
  if (!handler) return;
  const button = form.querySelector('[type=submit]');
  if (button) button.disabled = true;
  try {
    await handler(form, current.ctx, ev);
  } catch (err) {
    toast(err.message || String(err), { error: true });
  } finally {
    if (button) button.disabled = false;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeSheet();
});

window.addEventListener('hashchange', () => {
  nav.count++;
  closeSheet();
  render();
});
window.addEventListener('tp:render', () => render());
window.addEventListener('tp:stale', () => {
  closeSheet();
  refresh({ quiet: true });
});
window.addEventListener('tp:logout', () => {
  closeSheet();
  resetState();
  render();
  checkSetup();
});
window.addEventListener('tp:login', async (ev) => {
  // A brand-new account keeps the language that was on screen while creating it.
  if (ev.detail?.newAccount) languageChosenBeforeLogin = true;
  state.needsSetup = false;
  clearToast();
  render();
  await refresh();
  afterLogin();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.loaded) refresh({ quiet: true });
});

// Keep "in 2 h 15 min" style times fresh on the live screens.
setInterval(() => {
  if (current.view?.live && document.visibilityState === 'visible' && !sheetOpen() && !isEditing()) render();
}, 30_000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  // Tapping a notification while the app is open: jump to that lesson.
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type !== 'open') return;
    const hash = new URL(ev.data.url).hash || '#/';
    if (location.hash !== hash) location.hash = hash;
  });
}

if (auth.token) {
  loadCached();
  render();
  refresh().then(afterLogin);
} else {
  render();
  checkSetup();
}
