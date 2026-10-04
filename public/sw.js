// Simple Service Worker для PWA
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // не кэшируем API и uploads
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
