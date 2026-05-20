const express = require('express')
const webPush = require('web-push')
const fs = require('fs')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
require('dotenv').config()

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
const PORT = process.env.PORT || 3004
const SUBS_FILE = './subs.json'

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

// ─── VAPID ───────────────────────────────────────────────────────────────────
if (!process.env.PUBLIC_KEY || !process.env.PRIVATE_KEY) {
    console.error('❌ VAPID keys missing! Run: npm run generate-keys')
    console.error('   Then add PUBLIC_KEY and PRIVATE_KEY to your .env file')
    process.exit(1)
}

webPush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`,
    process.env.PUBLIC_KEY,
    process.env.PRIVATE_KEY
)

// ─── Subscriptions ────────────────────────────────────────────────────────────
let subscriptions = []

function loadSubs() {
    if (fs.existsSync(SUBS_FILE)) {
        try { subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) }
        catch { subscriptions = [] }
    }
}

function saveSubs() {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2))
}

loadSubs()

// ─── Connected socket clients (browser is open) ───────────────────────────────
// Map: endpoint -> socketId  (one device = one active socket)
const connectedClients = new Map()

io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`)

    // Client sends its push endpoint so we can map socket ↔ subscription
    socket.on('register', ({ endpoint }) => {
        if (endpoint) {
            connectedClients.set(endpoint, socket.id)
            console.log(`📍 Registered socket ${socket.id} → endpoint ...${endpoint.slice(-20)}`)
        }
    })

    socket.on('disconnect', () => {
        for (const [ep, sid] of connectedClients.entries()) {
            if (sid === socket.id) { connectedClients.delete(ep); break }
        }
        console.log(`🔌 Socket disconnected: ${socket.id}`)
    })
})

// ─── Send with retry + backoff (web-push only) ────────────────────────────────
async function sendWithRetry(sub, payload, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await webPush.sendNotification(sub, payload, {
                TTL: 86400,
                urgency: 'high',
                topic: 'notify'
            })
            return { success: true }
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                return { success: false, remove: true }
            }
            if (err.statusCode === 429 && attempt < retries) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
                continue
            }
            if (attempt === retries) {
                console.error(`Send failed after ${retries} attempts:`, err.message)
                return { success: false, error: err.message }
            }
        }
    }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        subscribers: subscriptions.length,
        online: connectedClients.size,
        timestamp: new Date().toISOString()
    })
})

app.get('/vapidPublicKey', (req, res) => {
    res.json({ key: process.env.PUBLIC_KEY })
})

app.post('/subscribe', (req, res) => {
    const { endpoint, expirationTime, keys, meta } = req.body

    if (!endpoint || !keys) {
        return res.status(400).json({ error: 'Invalid subscription' })
    }

    const sub = { endpoint, expirationTime, keys, meta: meta || {}, updatedAt: new Date().toISOString() }

    const idx = subscriptions.findIndex(s => s.endpoint === endpoint)
    if (idx !== -1) {
        subscriptions[idx] = sub
    } else {
        subscriptions.push(sub)
    }

    saveSubs()
    console.log(`✅ Subscriber saved. Total: ${subscriptions.length} | Browser: ${meta?.browser} on ${meta?.os}`)
    res.status(201).json({ success: true, total: subscriptions.length })
})

app.post('/unsubscribe', (req, res) => {
    const { endpoint } = req.body
    const before = subscriptions.length
    subscriptions = subscriptions.filter(s => s.endpoint !== endpoint)
    connectedClients.delete(endpoint)
    saveSubs()
    res.json({ success: true, removed: before - subscriptions.length })
})

// ─── Smart send: socket if browser open, web-push if closed ───────────────────
async function handleSend(req, res) {
    if (subscriptions.length === 0) {
        return res.status(400).json({ error: 'No subscribers' })
    }

    const body = req.body || {}

    const notifPayload = {
        title: body.title || '🔔 New Notification',
        body: body.body || 'You have a new message',
        url: body.url || '/',
        icon: '/icon.png',
        badge: '/badge.png',
        tag: body.tag || ('notif-' + Date.now()),
        requireInteraction: body.requireInteraction !== false,
        renotify: true,
        silent: false,
        timestamp: Date.now(),
        actions: body.actions || [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' }
        ],
        data: body.data || {}
    }

    const toRemove = []
    const results = { sent: 0, socketSent: 0, failed: 0, removed: 0 }

    await Promise.all(
        subscriptions.map(async (sub) => {
            const socketId = connectedClients.get(sub.endpoint)

            if (socketId && io.sockets.sockets.get(socketId)) {
                // Browser is open → deliver via socket (instant, with sound)
                io.to(socketId).emit('notification', notifPayload)
                results.socketSent++
                results.sent++
                console.log(`🔌 Socket delivery → ${socketId}`)
            } else {
                // Browser is closed → web-push
                const result = await sendWithRetry(sub, JSON.stringify(notifPayload))
                if (result.success) {
                    results.sent++
                } else {
                    results.failed++
                    if (result.remove) toRemove.push(sub.endpoint)
                }
            }
        })
    )

    if (toRemove.length > 0) {
        subscriptions = subscriptions.filter(s => !toRemove.includes(s.endpoint))
        saveSubs()
        results.removed = toRemove.length
    }

    console.log(`📤 Push results:`, results)
    res.json({ success: true, ...results })
}

app.post('/send', handleSend)
app.get('/send', handleSend)

app.get('/stats', (req, res) => {
    const byBrowser = {}
    subscriptions.forEach(s => {
        const b = s.meta?.browser || 'unknown'
        byBrowser[b] = (byBrowser[b] || 0) + 1
    })
    res.json({ total: subscriptions.length, online: connectedClients.size, byBrowser })
})

server.listen(PORT, () => {
    console.log(`\n🚀 Server running: http://localhost:${PORT}`)
    console.log(`📊 Loaded ${subscriptions.length} subscriber(s)`)
    console.log(`\n📋 Smart delivery:`)
    console.log(`   • Browser OPEN  → Socket.io (instant + sound loop)`)
    console.log(`   • Browser CLOSED → Web Push (OS notification)\n`)
})
