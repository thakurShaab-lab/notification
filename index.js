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

webPush.setVapidDetails(
    'mailto:test@test.com',
    process.env.PUBLIC_KEY,
    process.env.PRIVATE_KEY
)

let subscriptions = []
if (fs.existsSync(SUBS_FILE)) {
    try {
        subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE))
    } catch {
        subscriptions = []
    }
}

function saveSubs() {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2))
}

app.get('/vapidPublicKey', (req, res) => {
    res.send(process.env.PUBLIC_KEY)
})

app.post('/subscribe', (req, res) => {
    const sub = req.body

    const exists = subscriptions.find(s => s.endpoint === sub.endpoint)
    if (!exists) {
        subscriptions.push(sub)
        saveSubs()
    }

    console.log("✅ Total subscribers:", subscriptions.length)
    res.status(201).json({})
})

app.get('/send', async (req, res) => {
    if (subscriptions.length === 0) {
        return res.send("❌ No subscribers")
    }

    const payload = JSON.stringify({
        title: "🔥 Notification",
        body: "Works even when browser is closed",
        url: "https://google.com"
    })

    const failed = []

    await Promise.all(
        subscriptions.map(async sub => {
            try {
                await webPush.sendNotification(sub, payload)
            } catch (err) {
                if (err.statusCode === 404 || err.statusCode === 410) {
                    failed.push(sub)
                }
            }
        })
    )
    
    subscriptions = subscriptions.filter(s => !failed.includes(s))
    saveSubs()

    res.send("✅ Notification sent")
})

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`)
})