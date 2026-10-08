// Service worker for the installable PDF Editor (generated into app/sw.js by
// tools/build-offline.mjs, which fills in VERSION and FILES).
//
// On install it stores every file the app needs, so after the first visit the
// app opens and works with no internet connection. A new build has a new
// VERSION, which makes the browser fetch the new files and drop the old ones.

const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `pdf-editor-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // "reload" skips the browser's HTTP cache, so a new version never mixes in old files.
    await cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('pdf-editor-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('./') : undefined);
    return hit || fetch(req);
  })());
});
