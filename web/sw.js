// Service worker: shows reminder notifications and keeps the app usable offline.
const CACHE = 'tutor-planner-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./', './index.html']).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// App files: network first so updates show up straight away; the cache is the offline fallback.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // A navigation Request can't be re-used with options, so fetch it by URL.
        const response = await fetch(request.mode === 'navigate' ? request.url : request, { cache: 'no-cache' });
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        return (await cache.match(request)) || (await cache.match('./index.html')) || Response.error();
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // iOS requires every push to show a notification.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Tutor Planner', {
      body: data.body || '',
      tag: data.tag,
      data: { url: data.url || '#/' },
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '#/', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) {
          client.postMessage({ type: 'open', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
