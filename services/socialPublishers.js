// Per-platform publishers for the church social-broadcast feature.
//
// Each publisher takes (account, post) where:
//   account = social_accounts row { platform, access_token, meta, ... }
//   post    = { image_base64, image_mime, caption, public_image_url? }
//
// Returns { ok, external_id?, url?, error? }. Errors are returned, not thrown,
// so a single platform failure does not break the whole broadcast.
//
// Facebook Page is fully wired (Graph API). Instagram / X / WhatsApp are
// stubbed — they record the attempt and return a clear "not_configured"
// message until you wire credentials. To enable a stubbed platform, replace
// the body with the real API call following the FB example.

const axios = require('axios');

const GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE    = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ─────────────────────────────────────────────────────────────────────────────
// Facebook Page  (real)
// Posts a photo + caption to a Page. Requires:
//   account.meta.page_id      — the Page numeric id
//   account.access_token      — a long-lived Page Access Token (NOT user token)
//                               with pages_manage_posts + pages_read_engagement
// You can obtain one via Graph API Explorer → "Get Page Access Token".
// ─────────────────────────────────────────────────────────────────────────────
async function publishFacebookPage(account, post) {
  const pageId = account?.meta?.page_id;
  const token  = account?.access_token;
  if (!pageId || !token) {
    return { ok: false, error: 'Missing page_id or access_token on the connected account.' };
  }
  if (!post?.image_base64 && !post?.public_image_url) {
    return { ok: false, error: 'No image to publish.' };
  }

  try {
    // Build multipart body with native Node FormData / Blob (Node 18+).
    const form = new FormData();
    form.append('caption', post.caption || '');
    form.append('access_token', token);

    if (post.public_image_url) {
      form.append('url', post.public_image_url);
    } else {
      const buf  = Buffer.from(post.image_base64, 'base64');
      const blob = new Blob([buf], { type: post.image_mime || 'image/jpeg' });
      form.append('source', blob, 'flyer.jpg');
    }

    const r = await axios.post(`${GRAPH_BASE}/${pageId}/photos`, form, {
      // axios with native FormData lets node set the boundary header.
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
      timeout:          30_000,
    });

    const externalId = r.data?.post_id || r.data?.id;
    return {
      ok:          true,
      external_id: externalId,
      url:         externalId ? `https://www.facebook.com/${externalId}` : null,
    };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || 'Facebook publish failed';
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram  (stub)
// Requires a public image URL (Graph API will not accept binary uploads for IG).
// To enable: host the flyer somewhere reachable, then POST /{ig-user-id}/media
// with image_url + caption to create a container, then POST
// /{ig-user-id}/media_publish?creation_id=... to publish.
// ─────────────────────────────────────────────────────────────────────────────
async function publishInstagram(account, post) {
  const igUserId = account?.meta?.ig_user_id;
  const token    = account?.access_token;
  if (!igUserId || !token) {
    return { ok: false, error: 'Instagram needs ig_user_id + page access token. Connect via Settings.' };
  }
  if (!post?.public_image_url) {
    return {
      ok: false,
      error: 'Instagram requires a public image URL. The flyer must be hosted before publishing.',
    };
  }

  try {
    const create = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
      params:  { image_url: post.public_image_url, caption: post.caption || '', access_token: token },
      timeout: 30_000,
    });
    const creationId = create.data?.id;
    if (!creationId) return { ok: false, error: 'No creation id returned by Instagram.' };

    const pub = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
      params:  { creation_id: creationId, access_token: token },
      timeout: 30_000,
    });
    const externalId = pub.data?.id;
    return {
      ok:          true,
      external_id: externalId,
      url:         externalId ? `https://www.instagram.com/p/${externalId}` : null,
    };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || 'Instagram publish failed';
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// X / Twitter  (stub)
// X API v2 image posting requires a two-step OAuth1.0a upload to v1.1
// /media/upload then a v2 /2/tweets call. Worth implementing once the church
// has an X developer app and access tokens. For now we record the attempt.
// ─────────────────────────────────────────────────────────────────────────────
async function publishTwitter(account, post) {
  if (!account?.access_token) {
    return { ok: false, error: 'X account not connected. Add API credentials in Settings.' };
  }
  return {
    ok:    false,
    error: 'X / Twitter publishing is not enabled in this build. Account credentials saved; integration pending.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp  (stub)
// Uses WhatsApp Cloud API. Requires meta.phone_number_id + access_token, plus
// either a recipient list (broadcast) or a status endpoint (not yet generally
// available). Stubbed until the church provides a Cloud API setup.
// ─────────────────────────────────────────────────────────────────────────────
async function publishWhatsApp(account, post) {
  if (!account?.access_token || !account?.meta?.phone_number_id) {
    return { ok: false, error: 'WhatsApp Business account not connected.' };
  }
  return {
    ok:    false,
    error: 'WhatsApp broadcast is not enabled in this build. Account credentials saved; integration pending.',
  };
}

const PUBLISHERS = {
  facebook:  publishFacebookPage,
  instagram: publishInstagram,
  twitter:   publishTwitter,
  whatsapp:  publishWhatsApp,
};

async function publishToPlatform(platform, account, post) {
  const fn = PUBLISHERS[platform];
  if (!fn) return { ok: false, error: `Unknown platform: ${platform}` };
  return fn(account, post);
}

module.exports = {
  publishToPlatform,
  PUBLISHERS,
  GRAPH_VERSION,
};
