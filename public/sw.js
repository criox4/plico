// Offline-first: serve from cache, refresh in the background (stale-while-revalidate).
// ponytail: one cache that grows with each deploy's hashed assets; bump C (or prune by age) if size matters.
const C = 'splittr-v2' // v2: drops API responses v1 wrongly cached

self.addEventListener('install', e => {
  self.skipWaiting()
  e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'])))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const r = e.request
  // Only the app shell and static assets are cached. API data must always be live (sync.ts owns offline data).
  if (r.method !== 'GET' || !r.url.startsWith('http') || new URL(r.url).pathname.startsWith('/api/')) return
  const key = r.mode === 'navigate' ? '/' : r // every route is the same SPA shell
  e.respondWith((async () => {
    const c = await caches.open(C)
    const hit = await c.match(key)
    const net = fetch(r)
      .then(res => { if (res.ok || res.type === 'opaque') c.put(key, res.clone()); return res })
      .catch(() => hit || Response.error())
    if (hit) { e.waitUntil(net); return hit }
    return net
  })())
})
