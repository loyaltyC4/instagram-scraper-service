/**
 * browser.js — CloakBrowser singleton manager
 *
 * Keeps one persistent browser context alive, logged into Instagram.
 * Re-uses it for all scraping requests to avoid repeated logins.
 *
 * Changes from v1:
 *  - Timezone/locale auto-detected from server IP via geoip (Fix #2, #3)
 *  - dismissCookieConsent exported for use in scrapers (Fix #6)
 *  - isLoggedIn validates session cookies, not just DOM (Fix #5)
 */
import { launch } from 'cloakbrowser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { detectGeoIp } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, '..', '.sessions');
const INSTAGRAM_SESSION = path.join(SESSION_DIR, 'instagram');

// Ensure session dirs exist
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(INSTAGRAM_SESSION)) fs.mkdirSync(INSTAGRAM_SESSION, { recursive: true });

let _browser = null;
let _context = null;
let _geoip = null;

// ─── GeoIP resolution (cached) ──────────────────────────────────────────────
async function getGeoIp() {
  if (_geoip) return _geoip;
  _geoip = await detectGeoIp();
  return _geoip;
}

// ─── Browser context ─────────────────────────────────────────────────────────
export async function getBrowserContext() {
  if (_context) return _context;

  const geo = await getGeoIp();
  const timezone = process.env.BROWSER_TIMEZONE || geo.timezone;
  const locale = process.env.BROWSER_LOCALE || geo.locale;

  console.log('[browser] Launching CloakBrowser…');
  console.log(`[browser] User data dir: ${INSTAGRAM_SESSION}`);
  console.log(`[browser] Timezone: ${timezone}  Locale: ${locale}`);

  _browser = await launch({
    headless: true,
    userDataDir: INSTAGRAM_SESSION,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Get the default persistent context, or create one with proper geo
  const contexts = _browser.contexts();
  _context = contexts[0] || await _browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale,
    timezoneId: timezone,
  });

  console.log('[browser] Context ready.');
  return _context;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _context = null;
  }
}

export async function newPage() {
  const ctx = await getBrowserContext();
  return ctx.newPage();
}

// ─── Cookie consent dismissal ────────────────────────────────────────────────
// Exported so scrapers can call it after any navigation to instagram.com (Fix #6)
const CONSENT_SELECTORS = [
  'button:has-text("Allow all cookies")',
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Allow essential and optional cookies")',
  'button:has-text("Alle Cookies erlauben")',
  'button:has-text("Alle akzeptieren")',
  'button._a9--._ap36._a9_0',
  '[role="dialog"] button:first-of-type',
];

export async function dismissCookieConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`[consent] Dismissed via: ${sel}`);
        await btn.click();
        await page.waitForTimeout(1500);
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

// ─── Session validation (Fix #5) ─────────────────────────────────────────────
/**
 * Check if we're logged into Instagram.
 *
 * Three-layer validation:
 *  1. Cookie presence + expiry check (fast, no network)
 *  2. Navigate to /accounts/edit/ and check for login redirect (authoritative)
 *  3. Fall back to false on any unexpected error
 */
export async function isLoggedIn() {
  const ctx = await getBrowserContext();

  // Layer 1: Cookie check — fast, no network round-trip
  try {
    const cookies = await ctx.cookies('https://www.instagram.com');
    const sessionCookie = cookies.find((c) => c.name === 'sessionid');
    if (!sessionCookie || !sessionCookie.value) {
      console.log('[auth] No sessionid cookie → not logged in');
      return false;
    }
    if (sessionCookie.expires > 0 && sessionCookie.expires < Date.now() / 1000) {
      console.log('[auth] sessionid cookie expired → not logged in');
      return false;
    }
    console.log('[auth] sessionid cookie present and not expired');
  } catch (err) {
    console.warn('[auth] Cookie check error:', err.message);
    // Continue to Layer 2
  }

  // Layer 2: API-level validation — actually hit Instagram
  const page = await newPage();
  try {
    await page.goto('https://www.instagram.com/accounts/edit/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await dismissCookieConsent(page);

    const url = page.url();
    if (url.includes('/accounts/login/')) {
      console.log('[auth] Redirected to login → session invalid');
      return false;
    }
    console.log('[auth] Session validated via /accounts/edit/ → logged in');
    return true;
  } catch (err) {
    console.warn('[auth] Validation failed:', err.message);
    return false;
  } finally {
    await page.close();
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────
export async function loginInstagram(username, password) {
  const page = await newPage();
  try {
    console.log(`[login] Logging in as @${username}…`);
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    await dismissCookieConsent(page);

    const pageUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[login] Page URL: ${pageUrl}`);
    console.log(`[login] Page title: ${pageTitle}`);

    // Wait for the login form to render
    console.log('[login] Waiting for username input…');
    try {
      await page.waitForSelector('input[name="username"]', { timeout: 30000 });
      console.log('[login] Username input found.');
    } catch {
      const bodyText = await page.evaluate(() =>
        document.body?.innerText?.substring(0, 1000) || 'NO_BODY'
      );
      console.error(`[login] Login form not found. Page text: ${bodyText}`);
      throw new Error(`Login form did not render. URL: ${pageUrl}, Title: ${pageTitle}`);
    }

    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    await page.waitForURL('https://www.instagram.com/', { timeout: 20000 });

    // Dismiss post-login dialogs (save info, notifications)
    for (const text of ['Not now', 'Not Now']) {
      try {
        const btn = await page.waitForSelector(`button:has-text("${text}")`, { timeout: 4000 });
        if (btn) await btn.click();
      } catch { /* not shown */ }
    }

    console.log('[login] Login successful!');
    return { success: true };
  } catch (err) {
    console.error('[login] Failed:', err.message);
    return { success: false, error: err.message };
  } finally {
    await page.close();
  }
}
