/**
 * Minimal service worker: enough for installability, and enough that a dropped
 * connection shows the app rather than the browser's error page.
 *
 * Deliberately conservative. Attendance is a live record, so nothing under
 * /api/ is ever cached or served stale — a cached "you are present" would be a
 * lie. HTML is network-first so a deploy is picked up immediately. Only
 * content-hashed build assets are served cache-first, where staleness is
 * impossible by construction.
 */
const VERSION = 'v1'
const SHELL = `shell-${VERSION}`
const STATIC = `static-${VERSION}`
const OFFLINE = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll([OFFLINE, '/icon-192.png'])).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never cache the API, and never answer it from a cache.
  if (url.pathname.startsWith('/api/')) return

  // Build output is content-hashed, so it can be served from cache safely.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(request)
        if (hit) return hit
        const res = await fetch(request)
        if (res.ok) cache.put(request, res.clone())
        return res
      })
    )
    return
  }

  // Pages: always try the network first so attendance is never shown stale.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(OFFLINE)) ?? Response.error())
    )
  }
})
