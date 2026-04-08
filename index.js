const express = require('express')
const webPush = require('web-push')
const fs = require('fs')
const cors = require('cors')
require('dotenv').config()

const app = express()
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

// ─── Send with retry + backoff ────────────────────────────────────────────────
async function sendWithRetry(sub, payload, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await webPush.sendNotification(sub, payload, {
                TTL: 86400,         // 24h queue — critical for background delivery
                urgency: 'high',    // Wake up device immediately
                topic: 'notify'     // Dedup key on the push server side
            })
            return { success: true }
        } catch (err) {
            // Subscription expired/unsubscribed — remove it
            if (err.statusCode === 404 || err.statusCode === 410) {
                return { success: false, remove: true }
            }
            // Rate limited — exponential backoff
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
    res.json({ status: 'ok', subscribers: subscriptions.length, timestamp: new Date().toISOString() })
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
    saveSubs()
    res.json({ success: true, removed: before - subscriptions.length })
})

async function handleSend(req, res) {
    if (subscriptions.length === 0) {
        return res.status(400).json({ error: 'No subscribers' })
    }

    const body = req.body || {}

    // ─── CRITICAL: These settings make it work like Teams/Slack
    const payload = JSON.stringify({
        title: body.title || '🔔 New Notification',
        body: body.body || 'You have a new message',
        url: body.url || '/',
        icon: '/icon.png',
        badge: '/badge.png',
        // unique tag = never silently deduplicated
        tag: body.tag || ('notif-' + Date.now()),
        // requireInteraction:true = stays on screen until user clicks (Teams behaviour)
        requireInteraction: body.requireInteraction !== false,
        renotify: true,
        silent: false,
        timestamp: Date.now(),
        actions: body.actions || [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' }
        ],
        data: body.data || {}
    })

    const toRemove = []
    const results = { sent: 0, failed: 0, removed: 0 }

    await Promise.all(
        subscriptions.map(async sub => {
            const result = await sendWithRetry(sub, payload)
            if (result.success) {
                results.sent++
            } else {
                results.failed++
                if (result.remove) toRemove.push(sub.endpoint)
            }
        })
    )

    if (toRemove.length > 0) {
        subscriptions = subscriptions.filter(s => !toRemove.includes(s.endpoint))
        saveSubs()
        results.removed = toRemove.length
    }

    console.log(`📤 Push sent:`, results)
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
    res.json({ total: subscriptions.length, byBrowser })
})

app.listen(PORT, () => {
    console.log(`\n🚀 Server running: http://localhost:${PORT}`)
    console.log(`📊 Loaded ${subscriptions.length} subscriber(s)`)
    console.log(`\n📋 IMPORTANT FOR BACKGROUND NOTIFICATIONS:`)
    console.log(`   1. Open http://localhost:${PORT} in Chrome/Edge`)
    console.log(`   2. Click "Enable Background Notifications"`)
    console.log(`   3. CLOSE THE BROWSER COMPLETELY`)
    console.log(`   4. From another device/tab, hit POST /send`)
    console.log(`   5. Notification appears in OS notification center\n`)
})
