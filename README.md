# Instagram Scraper Service

Stealth Instagram scraper using CloakBrowser + Playwright. Bypasses Instagram's anti-bot detection to reliably scrape stories, following lists, and followers.

## Setup

### 1. Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

1. Push this repo to GitHub
2. Connect to Railway → New Project → Deploy from GitHub
3. Add environment variables:
   - `SCRAPER_SECRET` — a random secret string (Activity Mint uses this to authenticate)
   - `PORT` — Railway sets this automatically

### 2. Log into Instagram (one-time)

After deploying, call the login endpoint once with your dedicated Instagram account:

```bash
curl -X POST https://YOUR-RAILWAY-URL/login \
  -H "Content-Type: application/json" \
  -H "X-Secret: YOUR_SCRAPER_SECRET" \
  -d '{"username": "your_ig_bot_account", "password": "your_password"}'
```

The session is saved to `.sessions/instagram/` and persists between restarts.

**Use a dedicated bot account**, not your personal Instagram account.

### 3. Configure Activity Mint

In your Vercel project, add these environment variables:
- `SCRAPER_SERVICE_URL` — your Railway URL (e.g. `https://instagram-scraper.up.railway.app`)
- `SCRAPER_SECRET` — same secret as above

## API

### POST /scrape

```json
{
  "action": "followers" | "following" | "stories" | "profile",
  "payload": {
    "username": "natgeo",
    "limit": 200
  }
}
```

Returns: `{ ok: true, items: [...] }`

### GET /status

Returns: `{ ok: true, loggedIn: true }`

### GET /health

Returns: `{ ok: true }`

## Response Formats

**followers / following:**
```json
[
  {
    "userId": "123456",
    "username": "john_doe",
    "fullName": "John Doe",
    "profilePicUrl": "https://...",
    "isVerified": false,
    "isPrivate": false
  }
]
```

**stories:**
```json
[
  {
    "id": "...",
    "takenAt": 1716123456,
    "mediaType": "image" | "video",
    "imageUrl": "https://...",
    "videoUrl": null,
    "duration": null,
    "expiresAt": 1716209856
  }
]
```
