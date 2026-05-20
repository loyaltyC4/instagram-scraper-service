/**
 * utils.js — Shared utilities for the Instagram scraper
 *
 * - Retry with exponential backoff + jitter
 * - GeoIP-based timezone/locale detection
 */

// ─── Retry with exponential backoff ──────────────────────────────────────────
/**
 * Wrap an async function with retry logic.
 * Uses exponential backoff with jitter to avoid thundering herd.
 *
 * @param {Function} fn        - Async function to retry
 * @param {Object}   opts
 * @param {number}   opts.maxRetries  - Max attempts (default 3)
 * @param {number}   opts.baseDelay   - Initial delay in ms (default 1500)
 * @param {number}   opts.maxDelay    - Ceiling for delay (default 15000)
 * @param {string}   opts.label       - Label for log messages
 * @returns {Promise<*>}
 */
export async function withRetry(fn, {
  maxRetries = 3,
  baseDelay = 1500,
  maxDelay = 15000,
  label = 'operation',
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        console.warn(
          `[retry] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}. ` +
          `Retrying in ${Math.round(jitter)}ms…`
        );
        await sleep(jitter);
      }
    }
  }
  console.error(`[retry] ${label} failed after ${maxRetries} attempts.`);
  throw lastError;
}

// ─── GeoIP detection ─────────────────────────────────────────────────────────
/**
 * Detect the server's timezone, locale, and country from its external IP.
 * Falls back to env vars or sensible defaults on failure.
 *
 * Returns: { timezone, locale, ip, country, city }
 */
export async function detectGeoIp() {
  const services = [
    {
      url: 'https://ipapi.co/json/',
      parse: (d) => ({
        timezone: d.timezone,
        locale: d.languages?.split(',')?.[0],
        ip: d.ip,
        country: d.country_code,
        city: d.city,
      }),
    },
    {
      url: 'https://worldtimeapi.org/api/ip',
      parse: (d) => ({
        timezone: d.timezone,
        locale: null,
        ip: d.client_ip,
        country: null,
        city: null,
      }),
    },
  ];

  for (const svc of services) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(svc.url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) continue;
      const data = await resp.json();
      const result = svc.parse(data);

      if (result.timezone) {
        console.log(
          `[geoip] Detected: timezone=${result.timezone} locale=${result.locale || 'n/a'} ` +
          `ip=${result.ip || 'n/a'} country=${result.country || 'n/a'}`
        );
        return {
          timezone: result.timezone,
          locale: result.locale || process.env.BROWSER_LOCALE || 'en-US',
          ip: result.ip,
          country: result.country,
          city: result.city,
        };
      }
    } catch {
      // Try next service
    }
  }

  console.warn('[geoip] All services failed. Using env vars or defaults.');
  return {
    timezone: process.env.BROWSER_TIMEZONE || 'Europe/Berlin',
    locale: process.env.BROWSER_LOCALE || 'en-US',
    ip: null,
    country: null,
    city: null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
