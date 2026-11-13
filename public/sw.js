const CACHE_NAME = 'yagzshoes-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://unpkg.com/lucide@latest',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // CDN istekleri ağ hatası verebilir, allSettled benzeri hata toleransı
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(new Request(url, { mode: 'cors' })).catch(err => {
            console.warn('[SW] Precache atlandı:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Sadece GET isteklerini önbelleğe al
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // API çağrıları için: Ağ öncelikli, offline ise cache'e bakma (JSON API)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigasyon (sayfa geçişi) istekleri: Network first, offline'da /index.html dön
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Statik varlıklar ve CDN kaynakları: Cache first / Stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        // Arka planda güncelle
        fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(() => {
        // Offline ve cache'te yok
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
