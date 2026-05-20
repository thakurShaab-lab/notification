/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE WORKER — Background Push Notifications
   
   DELIVERY STRATEGY:
   ─────────────────
   • Browser OPEN  → Socket.io delivers to page directly (with looping sound)
   • Browser CLOSED → Push server wakes this SW → OS notification shown here
                      SW posts message to any open clients to trigger sound
   ═══════════════════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'notify-v2'
const ORIGIN = self.location.origin

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
            )
        ])
    )
})

// ─── PUSH — fires when browser is closed (web-push path) ──────────────────────
self.addEventListener('push', event => {
    console.log('[SW] Push received at:', new Date().toISOString())

    event.waitUntil((async () => {
        let data = {
            title: 'New Notification',
            body: 'You have a new message',
            url: '/',
            icon: ORIGIN + '/icon.png',
            badge: ORIGIN + '/badge.png',
            image: null,
            tag: 'msg-' + Date.now(),
            requireInteraction: true,
            silent: false,
            timestamp: Date.now(),
            actions: [],
            data: {}
        }

        if (event.data) {
            try {
                const parsed = event.data.json()
                data = { ...data, ...parsed }
                if (data.icon && !data.icon.startsWith('http')) data.icon = ORIGIN + data.icon
                if (data.badge && !data.badge.startsWith('http')) data.badge = ORIGIN + data.badge
                if (data.image && !data.image.startsWith('http')) data.image = ORIGIN + data.image
            } catch (e) {
                data.body = event.data.text()
            }
        }

        const isIOS = /iphone|ipad|ipod/i.test(self.navigator?.userAgent || '')

        const options = {
            body: data.body,
            icon: data.icon,
            badge: data.badge,
            tag: data.tag,
            renotify: true,
            requireInteraction: data.requireInteraction,
            silent: data.silent,
            timestamp: data.timestamp,
            data: { url: data.url, ...data.data }
        }

        if (data.image) options.image = data.image

        if (!isIOS) {
            options.vibrate = [200, 100, 200]
            options.actions = data.actions?.length > 0 ? data.actions : [
                { action: 'open', title: 'Open' },
                { action: 'dismiss', title: 'Dismiss' }
            ]
        }

        await self.registration.showNotification(data.title, options)

        // Tell any open browser tabs to play the notification sound
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        clientList.forEach(client => client.postMessage({ type: 'PLAY_NOTIFICATION_SOUND' }))
    })())
})

// ─── Notification Click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close()
    if (event.action === 'dismiss') return

    const targetUrl = event.notification.data?.url || '/'

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                // Tell all open tabs to stop the sound when user clicks
                clientList.forEach(c => c.postMessage({ type: 'STOP_NOTIFICATION_SOUND' }))
                for (const client of clientList) {
                    if ('focus' in client) {
                        client.focus()
                        if (new URL(client.url).pathname !== new URL(targetUrl, ORIGIN).pathname) {
                            client.navigate(targetUrl)
                        }
                        return
                    }
                }
                return clients.openWindow(targetUrl)
            })
    )
})

self.addEventListener('notificationclose', event => {
    console.log('[SW] Dismissed:', event.notification.tag)
})

// ─── Push Subscription Change (VAPID key rotation) ────────────────────────────
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil(
        self.registration.pushManager.subscribe(event.oldSubscription.options)
            .then(sub =>
                fetch('/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...sub.toJSON(), meta: { resubscribed: true } })
                })
            )
    )
})

self.addEventListener('sync', event => {
    if (event.tag === 'sync-subscription') {
        event.waitUntil(
            self.registration.pushManager.getSubscription()
                .then(sub => {
                    if (!sub) return
                    return fetch('/subscribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(sub.toJSON())
                    })
                })
        )
    }
})

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return
    if (!event.request.url.startsWith(ORIGIN)) return

    event.respondWith(
        fetch(event.request)
            .then(res => {
                if (res.ok) {
                    const clone = res.clone()
                    caches.open(CACHE_NAME).then(c => c.put(event.request, clone))
                }
                return res
            })
            .catch(() => caches.match(event.request))
    )
})
