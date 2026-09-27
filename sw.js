// Service worker til web push. Ingen caching (appen hentes altid frisk fra GitHub Pages).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Sammenskudsgilde', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', lang: 'da',
    tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        c.postMessage({ type: 'open', url });   // appen skifter selv til gildet
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
