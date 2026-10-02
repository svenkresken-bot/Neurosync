// Offline-Cache der App-Dateien (App-Shell). Messdaten liegen lokal im Browser.
const CACHE = 'neurosync-v1';
const FILES = ['./', 'index.html', 'style.css', 'icon.svg', 'manifest.webmanifest',
  'js/app.js', 'js/ble.js', 'js/charts.js', 'js/gait.js', 'js/simulator.js', 'js/store.js'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
