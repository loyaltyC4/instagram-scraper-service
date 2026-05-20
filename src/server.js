/**
 * server.js — Express REST API for Instagram scraping
 *
 * Endpoints:
 *   POST /scrape           { action, payload }  → items[]
 *   POST /login            { username, password } → { success }
 *   POST /inject-cookies   { sessionid, csrftoken?, ds_user_id? } → { ok }
 *   GET  /status           → { loggedIn, sessionPath }
 *   GET  /health           → 200 OK
 *
 * Designed to be a drop-in replacement for Apify actors for
 * actions that don't work reliably: stories, following lists, followers.
 *
 * v2: Added retry with exponential backoff around all scraper calls (Fix #7).
 */

import express from 'express';
import { isLoggedIn, loginInstagram, getBrowserContext } from './browser.js';
import { scrapeFollowers, scrapeFollowing, scrapeStories, scrapeProfile } from './scrapers.js';
import { withRetry } from './utils.js';

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

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── Status ──────────────────────────────────────────────────────────────────
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

// ─── Cookie Injection ─────────────────────────────────────────────────────────
app.post('/inject-cookies', async (req, res) => {
  const { sessionid, csrftoken, ds_user_id } = req.body || {};
  if (!sessionid) {
    return res.status(400).json({ error: 'sessionid is required' });
  }
  try {
    const ctx = await getBrowserContext();
    const cookies = [
      {
        name: 'sessionid',
        value: sessionid,
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ];
    if (csrftoken) {
      cookies.push({
        name: 'csrftoken',
        value: csrftoken,
        domain: '.instagram.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      });
    }
    if (ds_user_id) {
      cookies.push({
        name: 'ds_user_id',
        value: String(ds_user_id),
        domain: '.instagram.com',
        path: '/',
      });
    }
    await ctx.addCookies(cookies);
    console.log(`[inject-cookies] Injected ${cookies.length} cookie(s) into browser context`);
    res.json({ ok: true, message: 'Cookies injected. Call GET /status to verify login.' });
  } catch (err) {
    console.error('[inject-cookies] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Main scrape endpoint (Fix #7: retry wrapper) ────────────────────────────
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
        items = await withRetry(
          () => scrapeFollowers(clean, limit),
          { label: `followers(@${clean})`, maxRetries: 3 }
        );
        break;
      case 'following':
        items = await withRetry(
          () => scrapeFollowing(clean, limit),
          { label: `following(@${clean})`, maxRetries: 3 }
        );
        break;
      case 'stories':
        items = await withRetry(
          () => scrapeStories(clean),
          { label: `stories(@${clean})`, maxRetries: 3 }
        );
        break;
      case 'profile':
        items = [await withRetry(
          () => scrapeProfile(clean),
          { label: `profile(@${clean})`, maxRetries: 3 }
        )];
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    console.log(`[scrape] Returned ${items.length} items for @${clean}`);
    res.json({ ok: true, items });
  } catch (err) {
    console.error(`[scrape] Error (after retries):`, err.message);
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
