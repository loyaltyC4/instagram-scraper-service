/**
 * server.js — Express REST API for Instagram scraping
 *
 * Endpoints:
 *   POST /scrape        { action, payload }  → items[]
 *   POST /login         { username, password } → { success }
 *   GET  /status        → { loggedIn, sessionPath }
 *   GET  /health        → 200 OK
 *
 * Designed to be a drop-in replacement for Apify actors for
 * actions that don't work reliably: stories, following lists, followers.
 */

import express from 'express';
import { isLoggedIn, loginInstagram } from './browser.js';
import { scrapeFollowers, scrapeFollowing, scrapeStories, scrapeProfile } from './scrapers.js';

const app = express();
app.use(express.json());

// ─── Auth middleware ────────────────────────────────────────────────────────
const API_SECRET = process.env.SCRAPER_SECRET;
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (API_SECRET && req.headers['x-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── Status ─────────────────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  try {
    const loggedIn = await isLoggedIn();
    res.json({ ok: true, loggedIn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Login ──────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const result = await loginInstagram(username, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Main scrape endpoint ────────────────────────────────────────────────────
// Matches the same interface as Activity Mint's apify-proxy.js
// { action: 'followers'|'following'|'stories'|'profile', payload: { username, limit? } }
app.post('/scrape', async (req, res) => {
  const { action, payload = {} } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  const { username, limit = 200 } = payload;
  if (!username) return res.status(400).json({ error: 'Missing username' });

  const clean = username.replace('@', '');
  console.log(`[scrape] action=${action} username=@${clean} limit=${limit}`);

  try {
    let items;

    switch (action) {
      case 'followers':
        items = await scrapeFollowers(clean, limit);
        break;
      case 'following':
        items = await scrapeFollowing(clean, limit);
        break;
      case 'stories':
        items = await scrapeStories(clean);
        break;
      case 'profile':
        items = [await scrapeProfile(clean)];
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    console.log(`[scrape] Returned ${items.length} items for @${clean}`);
    res.json({ ok: true, items });
  } catch (err) {
    console.error(`[scrape] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🔍 Instagram Scraper Service running on port ${PORT}`);
  console.log(`   Auth: ${API_SECRET ? 'enabled (X-Secret header)' : 'disabled (set SCRAPER_SECRET to enable)'}`);
  console.log(`   Session: .sessions/instagram\n`);
});

export default app;
