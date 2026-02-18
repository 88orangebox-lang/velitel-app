const CACHE_NAME = 'velitel-v2-final';
const ASSETS = [
  './',
  './index.html',
  './sklad.html',
  './byty.html',
  './hazmat.html',
  './zasah_192.png',
  './zasah_512.png',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});