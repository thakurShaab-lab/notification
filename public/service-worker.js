/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE WORKER — Background Push Notifications
   
   HOW BACKGROUND DELIVERY WORKS:
   ─────────────────────────────
   1. Browser sends subscription to YOUR SERVER (endpoint + keys)
   2. YOUR SERVER sends push via web-push library to Google/Apple/MS servers
   3. Google/Apple/MS servers wake up the SERVICE WORKER on the device
   4. Service Worker shows the OS-native notification (even if browser = closed)
   
   The browser process does NOT need to be running.
   The Service Worker is woken up by the OS push service (FCM/APNs/WNS).
   ═══════════════════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'notify-v2'
const ORIGIN = self.location.origin

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
    console.log('[SW] Install')
    self.skipWaiting()
})

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    console.log('[SW] Activate')
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
            )
        ])
    )
})

// ─── PUSH — This fires even when browser is fully closed ─────────────────────
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

        console.log('[SW] Showing notification:', data.title)
        await self.registration.showNotification(data.title, options)
    })())
})

// ─── Notification Click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    console.log('[SW] Click:', event.action)
    event.notification.close()

    if (event.action === 'dismiss') return

    const targetUrl = event.notification.data?.url || '/'

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
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
    console.log('[SW] Subscription changed — re-subscribing')
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
