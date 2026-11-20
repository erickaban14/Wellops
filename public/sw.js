// Service worker: keeps the app shell available without a connection.
// Page loads go to the network first (free hosts answer with a browser-check page that must reach the server);
// static assets are served from cache and refreshed in the background (an upload shows up on the next load).
// API calls are never cached - offline work tickets are queued by the app itself.
const CACHE = 'wellops-shell-v6';
const SHELL = ['/css/app.css', '/icon.svg', '/favicon.svg', '/manifest.json', '/js/app.js', '/js/core.js', '/js/views.js', '/js/offline.js', '/js/chart.js',
  '/js/pages/dashboard.js', '/js/pages/planning.js', '/js/pages/operations.js', '/js/pages/hr.js', '/js/pages/inventory.js', '/js/pages/misc.js'];

// The host's browser check is a 200 text/html page; never cache it in place of a real file.
const isChallenge = async res => (res.headers.get('content-type') || '').includes('text/html') && (await res.clone().text()).includes('/aes.js');

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => fetch(u, { cache: 'reload' }).then(async r => {
  if (r.ok && !(r.headers.get('content-type') || '').includes('text/html')) await c.put(u, r);
}).catch(() => {})))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(async res => {
      if (res.ok && !(await isChallenge(res))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  const fresh = fetch(e.request, { cache: 'no-cache' }).then(res => {
    if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  });
  e.respondWith(caches.match(e.request).then(hit => {
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});
