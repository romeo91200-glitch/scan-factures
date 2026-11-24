// Service worker : l'app s'ouvre même sans réseau (les envois attendent le retour du réseau).
const CACHE = 'scan-factures-v5';
const FILES = ['./', 'index.html', 'style.css', 'config.js', 'analyzer.js', 'upload.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google & Drive : toujours en direct
  // Réseau d'abord, sans le cache du navigateur (GitHub Pages le garde 10 min) : une mise à jour
  // est vue au prochain lancement. Hors-ligne : la copie gardée par l'app.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
