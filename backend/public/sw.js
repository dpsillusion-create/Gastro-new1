// Minimaler Service Worker: macht die App installierbar. Netz zuerst (immer aktuell), Cache nur als Offline-Notlösung.
// API-Aufrufe werden nie gecacht (personenbezogene Daten).
const CACHE = 'app-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});

// ---- Push-Nachrichten (Web Push) ----
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { /* kein JSON */ }
  e.waitUntil(self.registration.showNotification(d.title || 'SmartShift Swap', {
    body: d.body || '', icon: '/jobs/icon-192.png', badge: '/jobs/icon-192.png', tag: d.tag || undefined, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (new URL(c.url).pathname.startsWith(url) && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
