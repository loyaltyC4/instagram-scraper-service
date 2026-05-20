/**
 * scrapers.js — Instagram scraping functions via CloakBrowser + Playwright
 *
 * v2 rewrite — addresses all 7 audit findings:
 *
 *  Fix #1: Migrated from deprecated web_profile_info to GraphQL doc_id queries.
 *          getUserId() has 3 fallback strategies.
 *  Fix #4: Removed interceptResponse entirely — no leaked response listeners.
 *          All API calls go through igFetch() (page.evaluate + fetch).
 *  Fix #6: dismissCookieConsent called after every navigation to instagram.com.
 *
 *  Fixes #2, #3, #5, #7 are in browser.js, utils.js, and server.js.
 */

import { newPage, dismissCookieConsent } from './browser.js';

const IG_BASE = 'https://www.instagram.com';

// Instagram web app client headers — required for API calls to return JSON
const IG_HEADERS = {
  'X-IG-App-ID': '936619743392459',
  'X-ASBD-ID': '198387',
  'X-Requested-With': 'XMLHttpRequest',
};

// GraphQL doc_ids — sourced from Instaloader PR #2652 (merged March 2026)
const DOC_ID = {
  profilePageContent: '25980296051578533', // PolarisProfilePageContentQuery
  profilePosts: '34579740524958711',       // PolarisProfilePostsQuery
};

// ─── Core: fetch Instagram API through the browser context ───────────────────
/**
 * Make an authenticated API call through the page's fetch().
 * Cookies are included automatically (same-origin + credentials: include).
 * Returns parsed JSON or throws with status code.
 *
 * The page MUST be on https://www.instagram.com/ before calling this.
 */
async function igFetch(page, url) {
  const result = await page.evaluate(
    async ({ url, headers }) => {
      try {
        const resp = await fetch(url, {
          headers,
          credentials: 'include',
        });
        const body = await resp.text();
        return { ok: resp.ok, status: resp.status, body };
      } catch (err) {
        return { ok: false, status: 0, body: err.message };
      }
    },
    { url, headers: IG_HEADERS }
  );

  if (!result.ok) {
    throw new Error(`IG API ${result.status}: ${result.body.substring(0, 300)}`);
  }

  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(`Failed to parse IG response as JSON (${result.body.substring(0, 100)})`);
  }
}

// ─── Core: initialize a page on instagram.com ────────────────────────────────
/**
 * Create a new page, navigate to instagram.com, dismiss cookie consent.
 * Returns a page ready for igFetch() calls.
 */
async function initPage() {
  const page = await newPage();
  try {
    await page.goto(`${IG_BASE}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await dismissCookieConsent(page);
    return page;
  } catch (err) {
    await page.close();
    throw new Error(`Failed to initialize Instagram page: ${err.message}`);
  }
}

// ─── Core: resolve user ID (Fix #1 — multi-strategy) ─────────────────────────
/**
 * Get a user's numeric ID from their username.
 *
 * Strategy order:
 *  1. GraphQL PolarisProfilePageContentQuery (doc_id 25980296051578533)
 *  2. Legacy web_profile_info with X-IG-App-ID header (still works per issue #2688)
 *  3. GraphQL PolarisProfilePostsQuery (doc_id 34579740524958711)
 *
 * Returns { userId: string, user: object } where user contains raw profile data.
 */
async function getUserId(page, username) {
  const errors = [];

  // Strategy 1: GraphQL PolarisProfilePageContentQuery
  try {
    const variables = JSON.stringify({ username });
    const url = `${IG_BASE}/graphql/query/?doc_id=${DOC_ID.profilePageContent}&variables=${encodeURIComponent(variables)}`;
    const data = await igFetch(page, url);

    const user =
      data?.data?.user ||
      data?.data?.xdt_api__v1__users__web_profile_info?.user;

    if (user && (user.id || user.pk)) {
      console.log(`[getUserId] Resolved @${username} via GraphQL ProfilePageContent → ${user.id || user.pk}`);
      return { userId: String(user.id || user.pk), user };
    }
  } catch (e) {
    errors.push(`GraphQL-ProfilePageContent: ${e.message}`);
  }

  // Strategy 2: Legacy web_profile_info (with required headers)
  try {
    const url = `${IG_BASE}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const data = await igFetch(page, url);
    const user = data?.data?.user;

    if (user && (user.id || user.pk)) {
      console.log(`[getUserId] Resolved @${username} via web_profile_info fallback → ${user.id || user.pk}`);
      return { userId: String(user.id || user.pk), user };
    }
  } catch (e) {
    errors.push(`web_profile_info: ${e.message}`);
  }

  // Strategy 3: GraphQL PolarisProfilePostsQuery
  try {
    const variables = JSON.stringify({
      data: { count: 1 },
      username,
      __relay_internal__pv__PolarisFeedShareMenurelayprovider: false,
    });
    const url = `${IG_BASE}/graphql/query/?doc_id=${DOC_ID.profilePosts}&variables=${encodeURIComponent(variables)}`;
    const data = await igFetch(page, url);

    // This endpoint nests user data inside timeline edges
    const user =
      data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges?.[0]?.node?.user ||
      data?.data?.user;

    if (user && (user.id || user.pk)) {
      console.log(`[getUserId] Resolved @${username} via GraphQL ProfilePosts → ${user.id || user.pk}`);
      return { userId: String(user.id || user.pk), user };
    }
  } catch (e) {
    errors.push(`GraphQL-ProfilePosts: ${e.message}`);
  }

  throw new Error(
    `Could not resolve user ID for @${username}. All strategies failed:\n  ${errors.join('\n  ')}`
  );
}

// ─── Normalize profile data ──────────────────────────────────────────────────
/**
 * Normalize profile data from different API response formats into a
 * consistent shape. Handles both web_profile_info format (edge_followed_by)
 * and v1 API format (follower_count).
 */
function normalizeProfile(user) {
  return {
    userId: String(user.id || user.pk),
    username: user.username,
    fullName: user.full_name,
    biography: user.biography || user.bio || null,
    profilePicUrl: user.profile_pic_url_hd || user.hd_profile_pic_url_info?.url || user.profile_pic_url,
    followersCount:
      user.edge_followed_by?.count ??
      user.follower_count ??
      null,
    followingCount:
      user.edge_follow?.count ??
      user.following_count ??
      null,
    postsCount:
      user.edge_owner_to_timeline_media?.count ??
      user.media_count ??
      null,
    isVerified: user.is_verified ?? false,
    isPrivate: user.is_private ?? false,
    isBusiness: user.is_business_account ?? user.is_business ?? false,
    businessCategory: user.business_category_name || user.category || null,
    externalUrl: user.external_url || null,
  };
}

// ─── Followers ───────────────────────────────────────────────────────────────
export async function scrapeFollowers(username, limit = 200) {
  const page = await initPage();
  try {
    const { userId } = await getUserId(page, username);
    const followers = [];
    let nextCursor = null;

    while (followers.length < limit) {
      const batchSize = Math.min(50, limit - followers.length);
      let url = `${IG_BASE}/api/v1/friendships/${userId}/followers/?count=${batchSize}`;
      if (nextCursor) url += `&max_id=${nextCursor}`;

      console.log(`[followers] Fetching batch (have ${followers.length}/${limit})…`);
      const data = await igFetch(page, url);
      const users = data?.users || [];

      for (const u of users) {
        followers.push({
          userId: String(u.pk || u.id),
          username: u.username,
          fullName: u.full_name,
          profilePicUrl: u.profile_pic_url,
          isVerified: u.is_verified || false,
          isPrivate: u.is_private || false,
        });
      }

      nextCursor = data?.next_max_id;
      if (!nextCursor || users.length === 0) break;
    }

    console.log(`[followers] Done: ${followers.length} followers for @${username}`);
    return followers.slice(0, limit);
  } finally {
    await page.close();
  }
}

// ─── Following ───────────────────────────────────────────────────────────────
export async function scrapeFollowing(username, limit = 200) {
  const page = await initPage();
  try {
    const { userId } = await getUserId(page, username);
    const following = [];
    let nextCursor = null;

    while (following.length < limit) {
      const batchSize = Math.min(50, limit - following.length);
      let url = `${IG_BASE}/api/v1/friendships/${userId}/following/?count=${batchSize}`;
      if (nextCursor) url += `&max_id=${nextCursor}`;

      console.log(`[following] Fetching batch (have ${following.length}/${limit})…`);
      const data = await igFetch(page, url);
      const users = data?.users || [];

      for (const u of users) {
        following.push({
          userId: String(u.pk || u.id),
          username: u.username,
          fullName: u.full_name,
          profilePicUrl: u.profile_pic_url,
          isVerified: u.is_verified || false,
          isPrivate: u.is_private || false,
        });
      }

      nextCursor = data?.next_max_id;
      if (!nextCursor || users.length === 0) break;
    }

    console.log(`[following] Done: ${following.length} following for @${username}`);
    return following.slice(0, limit);
  } finally {
    await page.close();
  }
}

// ─── Stories ─────────────────────────────────────────────────────────────────
export async function scrapeStories(username) {
  const page = await initPage();
  try {
    const { userId } = await getUserId(page, username);

    console.log(`[stories] Fetching reels for @${username} (id=${userId})…`);
    const url = `${IG_BASE}/api/v1/feed/reels_media/?reel_ids=${userId}`;
    const storiesData = await igFetch(page, url);

    const reels = storiesData?.reels || storiesData?.reels_media || {};
    const reel = reels[userId] || Object.values(reels)[0];
    const items = reel?.items || [];

    const stories = items.map((item) => {
      const isVideo = item.media_type === 2;
      return {
        id: String(item.id || item.pk),
        takenAt: item.taken_at,
        mediaType: isVideo ? 'video' : 'image',
        imageUrl: item.image_versions2?.candidates?.[0]?.url || null,
        videoUrl: isVideo ? (item.video_versions?.[0]?.url || null) : null,
        duration: item.video_duration || null,
        expiresAt: item.expiring_at || null,
        hasAudio: item.has_audio || false,
        viewCount: item.view_count || null,
      };
    });

    console.log(`[stories] Done: ${stories.length} stories for @${username}`);
    return stories;
  } finally {
    await page.close();
  }
}

// ─── Profile ─────────────────────────────────────────────────────────────────
export async function scrapeProfile(username) {
  const page = await initPage();
  try {
    const { user } = await getUserId(page, username);
    const profile = normalizeProfile(user);
    console.log(`[profile] Done: @${username} (${profile.followersCount ?? '?'} followers)`);
    return profile;
  } finally {
    await page.close();
  }
}
