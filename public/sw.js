const CACHE_NAME = 'chatze-v2-cache'
const STATIC_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/apple-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
]

// Install: Pre-cache core shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_PRECACHE)
    }).catch((err) => {
      console.warn('[SW Install Cache Warning]', err)
    })
  )
  self.skipWaiting()
})

// Activate: Clean up older cache generations
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  )
})

// Fetch strategy:
// 1. /api/* => Strictly Network Only (NEVER cache dynamic API)
// 2. /assets/* => Cache-First (Hashed Vite bundles never change)
// 3. Navigation / HTML => Stale-While-Revalidate with offline shell fallback
// 4. Other static images/fonts => Cache-First with network fallback
self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // 1. Skip non-GET and /api/* requests completely
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return
  }

  // 2. Hashed static assets (/assets/*): Cache-First
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req).then((res) => {
          if (res.ok && res.status === 200) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        })
      })
    )
    return
  }

  // 3. Navigation requests (HTML document): Stale-While-Revalidate with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.status === 200) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        })
        .catch(() => {
          return caches.match(req).then((cached) => {
            return cached || caches.match('/') || caches.match('/index.html')
          })
        })
    )
    return
  }

  // 4. Other static files (images, icons, manifest): Cache-First, then network fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached

      return fetch(req).then((res) => {
        if (res.ok && res.status === 200) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
        }
        return res
      }).catch(() => cached)
    })
  )
})

// Push Notifications handler
self.addEventListener('push', (event) => {
  let data = { title: 'New message', body: 'You received a new message.', url: '/', conversationId: undefined }
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() }
    }
  } catch {
    /* Ignore parse error */
  }

  const notificationOptions = {
    body: data.body,
    icon: '/pwa-192x192.png',
    badge: '/icon.svg',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
      conversationId: data.conversationId,
    },
    tag: data.conversationId ? `conv_${data.conversationId}` : 'chatze_chat',
    renotify: true,
  }

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Chatze', notificationOptions),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'relay:message',
            conversationId: data.conversationId,
            title: data.title,
            body: data.body,
          })
        })
      }),
    ])
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus()
          client.postMessage({
            type: 'relay:message',
            conversationId: event.notification.data?.conversationId,
          })
          return
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })
  )
})
