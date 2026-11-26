// Listen service worker — offline support (stale-while-revalidate) and Web Share Target.
const CACHE = 'listen-v0.1.0';
const CORE = ['/', '/index.html', '/style.css', '/app.js', '/site.webmanifest', '/favicon.ico',
  '/android-chrome-192x192.png', '/android-chrome-512x512.png', '/icons/favicon-32x32.png', '/icons/favicon-16x16.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'listen-share').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Files shared to the installed app arrive as a POST to /share-target
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      const form = await e.request.formData(), cache = await caches.open('listen-share');
      let i = 0;
      for (const f of form.getAll('media')) {
        if (!(f instanceof File)) continue;
        await cache.put('/shared/' + Date.now() + '-' + (i++), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name) } }));
      }
      return Response.redirect('/?share=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => cached);
    return cached || net;
  }));
});
