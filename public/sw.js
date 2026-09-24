// Offline-first: serve from cache, refresh in the background (stale-while-revalidate).
// ponytail: one cache that grows with each deploy's hashed assets; bump C (or prune by age) if size matters.
const C = 'plico-v6' // v6: push; v5: legal pages aren't the app shell; v4: share target; v3 Plico rebrand; v2 dropped API responses v1 wrongly cached
const SHARE = 'plico-share' // a screenshot shared into the installed app, waiting for the add screen

self.addEventListener('install', e => {
  self.skipWaiting()
  e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'])))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C && k !== SHARE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const r = e.request
  // Web Share Target (manifest): stash what was shared, then open the add screen, which picks it up.
  if (r.method === 'POST' && new URL(r.url).pathname === '/share-target') {
    e.respondWith((async () => {
      const f = await r.formData()
      const c = await caches.open(SHARE)
      const img = f.getAll('media').find(x => x && typeof x !== 'string' && x.type.startsWith('image/'))
      const text = [f.get('title'), f.get('text'), f.get('url')].filter(Boolean).join('\n')
      if (img) await c.put('/shared/image', new Response(img, { headers: { 'content-type': img.type } }))
      if (text) await c.put('/shared/text', new Response(text))
      return Response.redirect('/#/add/shared', 303)
    })())
    return
  }
  // Only the app shell and static assets are cached. API data must always be live (sync.ts owns offline data).
  if (r.method !== 'GET' || !r.url.startsWith('http') || new URL(r.url).pathname.startsWith('/api/')) return
  const path = new URL(r.url).pathname
  // The app lives at / (hash routes). Other pages (legal) are real documents: serve them as themselves.
  const key = r.mode === 'navigate' && (path === '/' || path === '/index.html') ? '/' : r
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

// Push: show it, grouped per group (tag) so a newer push replaces an older one instead of stacking.
self.addEventListener('push', e => {
  let m = {}
  try { m = e.data ? e.data.json() : {} } catch { m = { body: e.data && e.data.text() } }
  e.waitUntil(self.registration.showNotification(m.title || 'Plico', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: m.url || '#/' },
  }))
})

// A tap opens Plico where the push points: an open window is focused and told where to go, otherwise a new one opens there.
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '#/'
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const w = wins.find(c => new URL(c.url).origin === self.location.origin)
    if (w) { await w.focus(); w.postMessage({ type: 'open', url }); return }
    await self.clients.openWindow('/' + url)
  })())
})
