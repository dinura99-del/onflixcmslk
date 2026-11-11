const CACHE_NAME = 'onflix-cms-v2';
const PRECACHE_ASSETS = [
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon.svg',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/maskable-icon-512x512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Precache asset failed:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Only content-hashed build files and static icons/fonts are safe to serve from cache.
// App code and pages always come from the network so they never go out of sync.
function isCacheableStatic(url, request) {
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/assets/')) return true; // hashed build output
    return PRECACHE_ASSETS.includes(url.pathname);
  }
  return request.destination === 'font' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  // Pages: network only, with a cached copy only as an offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  if (!isCacheableStatic(url, event.request)) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      });
    })
  );
});
