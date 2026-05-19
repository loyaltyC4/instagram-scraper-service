/**
 * browser.js — CloakBrowser singleton manager
 *
 * Keeps one persistent browser context alive, logged into Instagram.
 * Re-uses it for all scraping requests to avoid repeated logins.
 */

import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, '..', '.sessions');
const INSTAGRAM_SESSION = path.join(SESSION_DIR, 'instagram');

// Ensure session dir exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

let _context = null;

export async function getBrowserContext() {
  if (_context) return _context;

  console.log('[browser] Launching CloakBrowser...');

  _context = await launchPersistentContext(INSTAGRAM_SESSION, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezone: 'America/New_York',
  });

  console.log('[browser] Context ready. Session stored at:', INSTAGRAM_SESSION);
  return _context;
}

export async function closeBrowser() {
  if (_context) { await _context.close(); _context = null; }
}

export async function newPage() {
  const ctx = await getBrowserContext();
  return ctx.newPage();
}

/**
 * Check if we appear to be logged into Instagram on the current context.
 */
export async function isLoggedIn() {
  const page = await newPage();
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Instagram shows "Log in" button when logged out
    const loginBtn = await page.$('a[href="/accounts/login/"]');
    return !loginBtn;
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

/**
 * Log in with username + password.
 * Only called once; session persists via launchPersistentContext.
 */
export async function loginInstagram(username, password) {
  const page = await newPage();
  try {
    console.log(`[login] Logging in as @${username}...`);
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Fill credentials
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // Wait for redirect to home feed
    await page.waitForURL('https://www.instagram.com/', { timeout: 20000 });

    // Dismiss "Save login info" dialog if present
    try {
      const notNowBtn = await page.waitForSelector('button:has-text("Not now")', { timeout: 5000 });
      if (notNowBtn) await notNowBtn.click();
    } catch { /* dialog not shown */ }

    // Dismiss notifications prompt if present
    try {
      const notNow2 = await page.waitForSelector('button:has-text("Not Now")', { timeout: 4000 });
      if (notNow2) await notNow2.click();
    } catch { /* not shown */ }

    console.log('[login] Login successful!');
    return { success: true };
  } catch (err) {
    console.error('[login] Failed:', err.message);
    return { success: false, error: err.message };
  } finally {
    await page.close();
  }
}
