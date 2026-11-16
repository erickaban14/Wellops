// Service worker: keeps the app shell available without a connection (network first, cache fallback).
// API calls are never cached here - offline work tickets are queued by the app itself.
const CACHE = 'wellops-shell-v1';
const SHELL = ['/', '/css/app.css', '/icon.svg', '/manifest.json', '/js/app.js', '/js/core.js', '/js/views.js', '/js/offline.js',
  '/js/pages/dashboard.js', '/js/pages/planning.js', '/js/pages/operations.js', '/js/pages/hr.js', '/js/pages/inventory.js', '/js/pages/misc.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/'))));
});
