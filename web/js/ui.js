// Shared UI plumbing: navigation, toasts and bottom sheets.
import { html } from './html.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export const rerender = () => window.dispatchEvent(new CustomEvent('tp:render'));

// Counts in-app navigations so "Back" knows whether there is somewhere to go back to.
export const nav = { count: 0 };

export function go(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

// Reads a form into a plain object (checkboxes become true/false).
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

let toastTimer;
export function clearToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast-root').innerHTML = '';
}

export function toast(message, { action, onAction, error = false } = {}) {
  const root = document.getElementById('toast-root');
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = String(html`<span>${message}</span>${action ? html`<button type="button">${action}</button>` : ''}`);
  if (action) {
    el.querySelector('button').addEventListener('click', async () => {
      el.remove();
      try {
        await onAction();
      } catch (err) {
        toast(err.message || String(err), { error: true });
      }
    });
  }
  root.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), action ? 6000 : error ? 5000 : 3000);
}

let current = null;
export const sheetOpen = () => current !== null;

export function closeSheet() {
  if (!current) return;
  const { el, onClose } = current;
  current = null;
  el.remove();
  document.body.classList.remove('sheet-open');
  onClose?.();
}

// A bottom sheet with a form. onSubmit(form) may return false to keep the sheet open.
// submitLabel: null gives a sheet without a submit button (e.g. a menu of links).
export function openSheet({ title, body, submitLabel = t('common.save'), submitClass = 'primary', onSubmit, danger, actions = {}, onClose }) {
  closeSheet();
  clearToast(); // an old toast would cover the sheet's fields
  const el = document.createElement('div');
  el.className = 'sheet-layer';
  el.innerHTML = String(html`
    <div class="sheet-backdrop" data-close></div>
    <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-grabber"></div>
      <header class="sheet-head">
        <h2 id="sheet-title">${title}</h2>
        <button type="button" class="icon-btn" data-close aria-label="${t('common.close')}">${icon('x')}</button>
      </header>
      <div class="sheet-body">${body}</div>
      ${submitLabel || danger
        ? html`<footer class="sheet-foot">
            ${danger ? html`<button type="button" class="btn danger-ghost" data-sheet-action="${danger.action}">${danger.label}</button>` : ''}
            ${submitLabel ? html`<button type="submit" class="btn ${submitClass}">${submitLabel}</button>` : ''}
          </footer>`
        : ''}
    </form>`);
  document.getElementById('sheet-root').appendChild(el);
  document.body.classList.add('sheet-open');
  current = { el, onClose };

  const form = el.querySelector('form');
  const run = async (fn, button) => {
    button.disabled = true;
    try {
      const result = await fn(form, button);
      // Only close this sheet if a newer one hasn't replaced it meanwhile.
      if (result !== false && current?.el === el) closeSheet();
    } catch (err) {
      toast(err.message || String(err), { error: true });
    } finally {
      button.disabled = false;
    }
  };
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const button = form.querySelector('[type=submit]');
    if (button) run(onSubmit ?? (() => {}), button);
  });
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) {
      closeSheet();
      return;
    }
    const button = ev.target.closest('[data-sheet-action]');
    if (button && actions[button.dataset.sheetAction]) run(actions[button.dataset.sheetAction], button);
  });
  requestAnimationFrame(() => el.classList.add('open'));
  return form;
}

export function confirmSheet({ title, message, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    openSheet({
      title,
      body: html`<p class="sheet-text">${message}</p>`,
      submitLabel: confirmLabel,
      submitClass: danger ? 'danger' : 'primary',
      onSubmit: () => resolve(true),
      onClose: () => resolve(false),
    });
  });
}
