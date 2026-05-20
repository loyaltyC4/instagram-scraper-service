/**
 * browser.js — CloakBrowser singleton manager
 *
 * Keeps one persistent browser context alive, logged into Instagram.
 * Re-uses it for all scraping requests to avoid repeated logins.
 */
import { launch } from 'cloakbrowser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, '..', '.sessions');
const INSTAGRAM_SESSION = path.join(SESSION_DIR, 'instagram');

// Ensure session dir exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(INSTAGRAM_SESSION)) fs.mkdirSync(INSTAGRAM_SESSION, { recursive: true });

let _browser = null;
let _context = null;

export async function getBrowserContext() {
  if (_context) return _context;
  console.log('[browser] Launching CloakBrowser...');
  console.log('[browser] User data dir:', INSTAGRAM_SESSION);

  // CloakBrowser uses launch() with userDataDir for persistent sessions
  _browser = await launch({
    headless: true,
    userDataDir: INSTAGRAM_SESSION,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Get the default context (persistent with userDataDir)
  const contexts = _browser.contexts();
  _context = contexts[0] || await _browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
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

/**
 * Dismiss any GDPR/cookie consent dialogs that Instagram shows on EU IPs.
 * Tries multiple known button selectors.
 */
async function dismissCookieConsent(page) {
  const consentSelectors = [
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Allow essential and optional cookies")',
    'button:has-text("Alle Cookies erlauben")',
    'button:has-text("Alle akzeptieren")',
    'button._a9--._ap36._a9_0',
    '[role="dialog"] button:first-of-type',
  ];

  for (const sel of consentSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`[consent] Found consent button: ${sel}`);
        await btn.click();
        await page.waitForTimeout(2000);
        return true;
      }
    } catch { /* try next */ }
  }
  console.log('[consent] No consent dialog found (may not be EU or already accepted)');
  return false;
}

/**
 * Check if we appear to be logged into Instagram on the current context.
 */
export async function isLoggedIn() {
  const page = await newPage();
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await dismissCookieConsent(page);
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
 * Only called once; session persists via userDataDir.
 */
export async function loginInstagram(username, password) {
  const page = await newPage();
  try {
    console.log(`[login] Logging in as @${username}...`);
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    // Handle GDPR/cookie consent (common on EU server IPs)
    await dismissCookieConsent(page);

    // Log current page state for debugging
    const pageUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[login] Page URL: ${pageUrl}`);
    console.log(`[login] Page title: ${pageTitle}`);

    // Wait explicitly for the login form to render (SPA takes time)
    console.log('[login] Waiting for username input...');
    try {
      await page.waitForSelector('input[name="username"]', { timeout: 30000 });
      console.log('[login] Username input found!');
    } catch (e) {
      // If the input still doesn't appear, log page content for debugging
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || 'NO_BODY');
      console.error(`[login] Username input NOT found after 30s. Page text: ${bodyText}`);
      throw new Error(`Login form did not render. URL: ${pageUrl}, Title: ${pageTitle}`);
    }

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
