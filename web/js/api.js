import { t, errorText } from './i18n.js';

const TOKEN_KEY = 'tp.token';
const base = (window.APP_CONFIG?.apiBase || '').replace(/\/+$/, '');

let token = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  // storage unavailable (private mode): stay logged out
}

export const auth = {
  get token() {
    return token;
  },
  set(value) {
    token = value;
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {}
  },
  clear() {
    token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  if (base.includes('REPLACE_WITH')) throw new ApiError(0, t('error.notConnected'));
  const headers = {};
  const sentToken = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, t('error.offline'));
  }
  const data = await res.json().catch(() => ({}));
  // The session ended (expired, password reset by the owner, account removed): back to the login screen.
  // A wrong password or setup code is a 401 too, but must keep what was typed in the form.
  if (res.status === 401 && sentToken && data.code === 'not_logged_in') {
    auth.clear();
    window.dispatchEvent(new CustomEvent('tp:logout'));
  }
  // Something this screen showed no longer exists (e.g. deleted on another device): reload the data.
  if (data.code === 'ref_not_found' || data.code === 'not_found') window.dispatchEvent(new CustomEvent('tp:stale'));
  if (!res.ok) throw new ApiError(res.status, errorText(data.code, data.error || t('error.generic', { status: res.status })));
  return data;
}
