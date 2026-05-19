/**
 * scrapers.js — Instagram scraping functions via CloakBrowser + Playwright
 *
 * All functions intercept Instagram's internal XHR/GraphQL responses
 * rather than parsing DOM, which is more reliable and faster.
 */

import { newPage } from './browser.js';

const IG_BASE = 'https://www.instagram.com';

// ─── Helper: intercept Instagram API response ──────────────────────────────
async function interceptResponse(page, urlPattern, triggerFn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for Instagram response')), timeoutMs);

    page.on('response', async (response) => {
      const url = response.url();
      if (urlPattern.test(url)) {
        clearTimeout(timer);
        try {
          const json = await response.json();
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      }
    });

    triggerFn().catch(reject);
  });
}

// ─── Followers ─────────────────────────────────────────────────────────────
export async function scrapeFollowers(username, limit = 200) {
  const page = await newPage();
  try {
    const followers = [];
    let nextCursor = null;
    let userId = null;

    // First get user ID from profile page
    const profileData = await interceptResponse(
      page,
      /\/api\/v1\/users\/web_profile_info/,
      () => page.goto(`${IG_BASE}/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    );

    userId = profileData?.data?.user?.id;
    if (!userId) throw new Error(`Could not find user ID for @${username}`);

    // Paginate followers
    while (followers.length < limit) {
      const batchSize = Math.min(50, limit - followers.length);
      const url = nextCursor
        ? `${IG_BASE}/api/v1/friendships/${userId}/followers/?count=${batchSize}&max_id=${nextCursor}`
        : `${IG_BASE}/api/v1/friendships/${userId}/followers/?count=${batchSize}`;

      const data = await interceptResponse(
        page,
        /\/api\/v1\/friendships\/\d+\/followers/,
        () => page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
      );

      const users = data?.users || [];
      for (const u of users) {
        followers.push({
          userId: u.pk || u.id,
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

    return followers.slice(0, limit);
  } finally {
    await page.close();
  }
}

// ─── Following ─────────────────────────────────────────────────────────────
export async function scrapeFollowing(username, limit = 200) {
  const page = await newPage();
  try {
    const following = [];
    let nextCursor = null;
    let userId = null;

    // Get user ID
    const profileData = await interceptResponse(
      page,
      /\/api\/v1\/users\/web_profile_info/,
      () => page.goto(`${IG_BASE}/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    );

    userId = profileData?.data?.user?.id;
    if (!userId) throw new Error(`Could not find user ID for @${username}`);

    // Paginate following
    while (following.length < limit) {
      const batchSize = Math.min(50, limit - following.length);
      const url = nextCursor
        ? `${IG_BASE}/api/v1/friendships/${userId}/following/?count=${batchSize}&max_id=${nextCursor}`
        : `${IG_BASE}/api/v1/friendships/${userId}/following/?count=${batchSize}`;

      const data = await interceptResponse(
        page,
        /\/api\/v1\/friendships\/\d+\/following/,
        () => page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
      );

      const users = data?.users || [];
      for (const u of users) {
        following.push({
          userId: u.pk || u.id,
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

    return following.slice(0, limit);
  } finally {
    await page.close();
  }
}

// ─── Stories ───────────────────────────────────────────────────────────────
export async function scrapeStories(username) {
  const page = await newPage();
  try {
    const stories = [];

    // Get user ID and story tray from profile
    const profileData = await interceptResponse(
      page,
      /\/api\/v1\/users\/web_profile_info/,
      () => page.goto(`${IG_BASE}/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    );

    const userId = profileData?.data?.user?.id;
    if (!userId) throw new Error(`Could not find user ID for @${username}`);

    // Fetch stories reel
    const storiesData = await interceptResponse(
      page,
      /\/api\/v1\/feed\/reels_media/,
      () => page.goto(
        `${IG_BASE}/api/v1/feed/reels_media/?reel_ids=${userId}`,
        { waitUntil: 'networkidle', timeout: 20000 }
      )
    );

    const reels = storiesData?.reels || storiesData?.reels_media || {};
    const reel = reels[userId] || Object.values(reels)[0];
    const items = reel?.items || [];

    for (const item of items) {
      const isVideo = item.media_type === 2;
      stories.push({
        id: item.id || item.pk,
        takenAt: item.taken_at,
        mediaType: isVideo ? 'video' : 'image',
        imageUrl: item.image_versions2?.candidates?.[0]?.url || null,
        videoUrl: isVideo ? item.video_versions?.[0]?.url || null : null,
        duration: item.video_duration || null,
        expiresAt: item.expiring_at || null,
        hasAudio: item.has_audio || false,
        viewCount: item.view_count || null,
      });
    }

    return stories;
  } finally {
    await page.close();
  }
}

// ─── Profile ───────────────────────────────────────────────────────────────
export async function scrapeProfile(username) {
  const page = await newPage();
  try {
    const profileData = await interceptResponse(
      page,
      /\/api\/v1\/users\/web_profile_info/,
      () => page.goto(`${IG_BASE}/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    );

    const user = profileData?.data?.user;
    if (!user) throw new Error(`Profile not found for @${username}`);

    return {
      userId: user.id,
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followersCount: user.edge_followed_by?.count,
      followingCount: user.edge_follow?.count,
      postsCount: user.edge_owner_to_timeline_media?.count,
      isVerified: user.is_verified,
      isPrivate: user.is_private,
      isBusiness: user.is_business_account,
      businessCategory: user.business_category_name,
      externalUrl: user.external_url,
    };
  } finally {
    await page.close();
  }
}
