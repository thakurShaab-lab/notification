# 🔔 Push Notifications — Background Delivery (Teams-style)

Notifications appear even when the browser is **completely closed**.

## Why it works

```
Your Server → Google/Apple/MS Push Servers → OS wakes Service Worker → OS shows notification
```

The **OS** delivers it, not the browser. Same as Teams, Slack, Gmail.

## Setup

```bash
npm install
npm run generate-keys   # copy output into .env
npm run dev
```

**.env**
```
PUBLIC_KEY=...
PRIVATE_KEY=...
VAPID_EMAIL=you@example.com
```

## Test background delivery
1. Open `http://localhost:3004` in Chrome/Edge
2. Click **Enable Background Notifications** (complete all 3 steps)
3. **Close the browser completely**
4. `POST /send` → notification pops up bottom-right of screen

## Critical settings (what was missing before)

| Setting | Value | Effect |
|---------|-------|--------|
| `TTL: 86400` | 24h | Queues if device offline |
| `urgency: high` | high | Wakes device immediately |
| `requireInteraction: true` | true | Stays visible like Teams |
| `renotify: true` | true | Always shows, no dedup |
| unique `tag` per send | — | Prevents silent suppression |

## iOS
Must install as PWA: Safari → Share ⎙ → Add to Home Screen → open from home screen.

## Browser support
Chrome ✅ · Edge ✅ · Firefox ✅ · Android Chrome ✅ · Samsung Internet ✅ · Safari macOS 13+ ✅ · Safari iOS 16.4+ (PWA only) ✅
