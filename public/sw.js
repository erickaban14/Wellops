// Retired service worker. On free hosting the host's browser-check page replaces scripts at random,
// so a cached app shell went stale or empty. This version clears its caches and removes itself.
// ponytail: no offline start-up; bring back a service worker on a host without a browser check.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
