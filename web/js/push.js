// Turning lesson notifications on and off for this device.
import { api } from './api.js';
import { state } from './store.js';
import { t } from './i18n.js';

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function pushEnvironment() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return {
    supported,
    ios: isIOS(),
    standalone: isStandalone(),
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function keyBytes(b64url) {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function sameKey(sub, key) {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.pushManager ? reg.pushManager.getSubscription() : null;
}

async function register(sub) {
  const res = await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel(), timezone: timezone() });
  state.devices = res.devices;
}

// Call straight from a tap: iOS only shows the permission prompt in response to a user gesture.
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(t(permission === 'denied' ? 'push.blocked' : 'push.notAllowed'));
  }
  if (!state.vapidPublicKey) throw new Error(t('push.noServerKey'));
  const reg = await navigator.serviceWorker.ready;
  const key = keyBytes(state.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await register(sub);
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  const res = await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  state.devices = res.devices;
  await sub.unsubscribe();
}

export async function sendTestPush() {
  const sub = await currentSubscription();
  if (!sub) throw new Error(t('push.notOn'));
  return api('POST', '/api/push/test', { endpoint: sub.endpoint });
}

// On start-up: make sure the server still knows this device and its time zone.
export async function syncDevice() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub) await register(sub);
}
