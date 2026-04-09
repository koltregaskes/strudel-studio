const CACHE_NAME = 'strudel-studio-v3-20260409';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isNavigation = event.request.mode === 'navigate';
  const isCoreShellAsset = isSameOrigin && APP_SHELL.some((asset) => requestUrl.pathname.endsWith(asset.replace('./', '/')) || (asset === './' && requestUrl.pathname === '/'));

  event.respondWith(
    (isNavigation || isCoreShellAsset
      ? fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse.ok && isSameOrigin) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
            }
            return networkResponse;
          })
          .catch(() => caches.match(event.request).then((cachedResponse) => cachedResponse || caches.match('./index.html')))
      : caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }

          return fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse.ok && isSameOrigin) {
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
              }
              return networkResponse;
            })
            .catch(() => caches.match('./index.html'));
        }))
  );
});
