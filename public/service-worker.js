self.addEventListener('install', event => {
    self.skipWaiting()
})

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener('push', event => {
    let data = {}

    try {
        data = event.data.json()
    } catch {
        data = {
            title: "Default Title",
            body: "Default Body",
            url: "/"
        }
    }

    const options = {
        body: data.body,
        icon: '/icon.png',
        badge: '/badge.png',
        vibrate: [100, 50, 100],
        data: { url: data.url },
        actions: [
            { action: 'open', title: 'Open' },
            { action: 'close', title: 'Dismiss' }
        ]
    }

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    )
})

self.addEventListener('notificationclick', event => {
    event.notification.close()

    if (event.action === 'close') return

    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true })
            .then(clientList => {
                for (const client of clientList) {
                    if (client.url === '/' && 'focus' in client) {
                        return client.focus()
                    }
                }
                return clients.openWindow(event.notification.data.url || '/')
            })
    )
})