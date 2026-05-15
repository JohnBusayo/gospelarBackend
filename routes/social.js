// routes/social.js
// Social media broadcast: connect platform accounts, queue or publish a flyer
// + caption to all of them at once. Platform-specific publish logic lives in
// services/socialPublishers.js — this file owns persistence, dispatch, and
// the once-a-minute scheduled-post worker.

const express = require('express');
const db = require('../db');
const { churchAuth, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../middleware/activity');
const { publishToPlatform } = require('../services/socialPublishers');

const router = express.Router();

const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'twitter', 'whatsapp'];

// Strip tokens before returning an account row to the client.
function safeAccount(row) {
  if (!row) return row;
  return {
    id:            row.id,
    platform:      row.platform,
    account_label: row.account_label,
    external_id:   row.external_id,
    meta:          row.meta || {},
    status:        row.status,
    connected_by:  row.connected_by,
    created_at:    row.created_at,
    updated_at:    row.updated_at,
    has_token:     !!row.access_token,
  };
}

router.get('/api/church-admin/social/accounts', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const r = await db.query(
      `SELECT * FROM social_accounts WHERE church_id = $1 ORDER BY platform ASC`,
      [req.church.id],
    );
    res.json({ accounts: r.rows.map(safeAccount) });
  } catch (e) {
    console.error('GET /api/church-admin/social/accounts:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load social accounts.' });
  }
});

// Body: { platform, account_label, external_id?, access_token, refresh_token?, meta? }
// Upserts the (church, platform) pair. We don't run OAuth here — the church
// admin pastes credentials they obtained from each platform's dev portal.
router.post('/api/church-admin/social/accounts', churchAuth, requirePerm('social', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const platform = String(req.body?.platform || '').toLowerCase().trim();
  if (!SOCIAL_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${SOCIAL_PLATFORMS.join(', ')}` });
  }
  const accessToken = String(req.body?.access_token || '').trim();
  if (!accessToken) return res.status(400).json({ error: 'access_token is required.' });

  const accountLabel = req.body?.account_label ? String(req.body.account_label).trim() : null;
  const externalId   = req.body?.external_id   ? String(req.body.external_id).trim()   : null;
  const refreshToken = req.body?.refresh_token ? String(req.body.refresh_token).trim() : null;
  const meta         = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};

  try {
    const r = await db.query(
      `INSERT INTO social_accounts
         (church_id, platform, account_label, external_id, access_token, refresh_token, meta, connected_by, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',NOW())
       ON CONFLICT (church_id, platform) DO UPDATE
         SET account_label = EXCLUDED.account_label,
             external_id   = EXCLUDED.external_id,
             access_token  = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             meta          = EXCLUDED.meta,
             connected_by  = EXCLUDED.connected_by,
             status        = 'active',
             updated_at    = NOW()
       RETURNING *`,
      [req.church.id, platform, accountLabel, externalId, accessToken, refreshToken,
       JSON.stringify(meta), req.staff?.email || null],
    );
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'social.connected', entity_type: 'social_account', entity_id: r.rows[0].id,
      summary: `Connected ${platform}${accountLabel ? ` (${accountLabel})` : ''}`,
    });
    res.status(201).json({ account: safeAccount(r.rows[0]) });
  } catch (e) {
    console.error('POST /api/church-admin/social/accounts:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save social account.' });
  }
});

router.delete('/api/church-admin/social/accounts/:id', churchAuth, requirePerm('social', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `DELETE FROM social_accounts WHERE id = $1 AND church_id = $2 RETURNING platform, account_label`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'social.disconnected', entity_type: 'social_account', entity_id: id,
      summary: `Disconnected ${r.rows[0].platform}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/social/accounts/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to disconnect account.' });
  }
});

router.get('/api/church-admin/social/posts', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const r = await db.query(
      `SELECT id, branch_id, caption, platforms, results, status,
              scheduled_at, published_at, created_by, created_at, image_mime,
              CASE WHEN image_base64 IS NULL THEN NULL
                   ELSE 'data:' || image_mime || ';base64,' || image_base64
              END AS image_data_url
         FROM social_posts
        WHERE church_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.church.id, limit],
    );
    res.json({ posts: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/social/posts:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load post history.' });
  }
});

// Public flyer host. Anyone with the numeric id can fetch — flyers are public
// announcements so that's intentional. Add a signed-token gate later if you
// ever store something more sensitive here.
router.get('/api/social/media/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
  try {
    const r = await db.query(
      `SELECT image_base64, image_mime FROM social_posts WHERE id = $1`,
      [id],
    );
    if (!r.rows.length || !r.rows[0].image_base64) return res.status(404).send('Not found');
    const buf = Buffer.from(r.rows[0].image_base64, 'base64');
    res.set('Content-Type',  r.rows[0].image_mime || 'image/jpeg');
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('GET /api/social/media/:id:', e.code, e.message);
    res.status(500).send('Failed to load image');
  }
});

// Resolve the public base URL platforms hit when fetching flyers.
// Preference order:
//   1. process.env.PUBLIC_API_URL — explicit, recommended for production.
//   2. req.protocol + Host header — works in dev, falls down behind proxies.
//   3. null — no public URL available; FB falls back to multipart, IG fails.
function publicApiBase(req) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host  = req.get?.('host');
    if (host) return `${proto}://${host}`;
  }
  return null;
}

// Used by both the POST endpoint and the scheduled-post worker. Flips status
// to 'publishing' before fan-out, then 'published'|'partial'|'failed' after.
async function dispatchSocialPost({ postRow, churchId, branchId, actor, baseUrl, providedPublicUrl }) {
  const platforms = Array.isArray(postRow.platforms)
    ? postRow.platforms
    : (typeof postRow.platforms === 'string' ? JSON.parse(postRow.platforms || '[]') : []);

  // Mark as publishing so a concurrent worker run doesn't pick it up.
  await db.query(
    `UPDATE social_posts SET status = 'publishing', updated_at = NOW() WHERE id = $1`,
    [postRow.id],
  );

  let accounts;
  try {
    const a = await db.query(
      `SELECT * FROM social_accounts
        WHERE church_id = $1 AND platform = ANY($2::text[]) AND status = 'active'`,
      [churchId, platforms],
    );
    accounts = Object.fromEntries(a.rows.map((row) => [row.platform, row]));
  } catch (e) {
    console.error('dispatchSocialPost (accounts):', e.code, e.message);
    await db.query(
      `UPDATE social_posts SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [postRow.id],
    );
    return { results: {}, status: 'failed' };
  }

  // Prefer caller-provided URL (host elsewhere); else fall back to our route.
  const publicImageUrl = providedPublicUrl
    || (postRow.image_base64 && baseUrl ? `${baseUrl}/api/social/media/${postRow.id}` : null);

  const post = {
    image_base64:     postRow.image_base64,
    image_mime:       postRow.image_mime,
    caption:          postRow.caption,
    public_image_url: publicImageUrl,
  };

  const dispatches = await Promise.all(platforms.map(async (p) => {
    const acct = accounts[p];
    if (!acct) return [p, { ok: false, error: `${p} is not connected. Connect it first.` }];
    try {
      const out = await publishToPlatform(p, acct, post);
      return [p, out];
    } catch (err) {
      return [p, { ok: false, error: err?.message || 'Publisher threw' }];
    }
  }));
  const results = Object.fromEntries(dispatches);
  const allOk   = dispatches.every(([, v]) => v?.ok);
  const anyOk   = dispatches.some(([, v]) => v?.ok);
  const finalStatus = allOk ? 'published' : anyOk ? 'partial' : 'failed';

  try {
    await db.query(
      `UPDATE social_posts
          SET results = $1, status = $2, published_at = NOW(), updated_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(results), finalStatus, postRow.id],
    );
  } catch (e) {
    console.error('dispatchSocialPost (update):', e.code, e.message);
  }

  logActivity({
    church_id: churchId, branch_id: branchId || null,
    actor_email: actor?.email, actor_name: actor?.name,
    action: 'social.posted', entity_type: 'social_post', entity_id: postRow.id,
    summary: `Broadcast flyer to ${platforms.join(', ')} (${finalStatus})`,
    metadata: { platforms, status: finalStatus, scheduled: !!postRow.scheduled_at },
  });

  return { results, status: finalStatus };
}

// Body: { image_base64, image_mime?, caption?, platforms:[...], scheduled_at?, public_image_url? }
// scheduled_at in the future → row saved with status='scheduled', the worker
// publishes later. Otherwise dispatches in parallel and stores per-platform results.
router.post('/api/church-admin/social/posts', churchAuth, requirePerm('social', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });

  const imageBase64 = req.body?.image_base64 ? String(req.body.image_base64) : null;
  const imageMime   = String(req.body?.image_mime || 'image/jpeg');
  const caption     = req.body?.caption != null ? String(req.body.caption) : '';
  const publicUrl   = req.body?.public_image_url ? String(req.body.public_image_url) : null;
  const platforms   = Array.isArray(req.body?.platforms)
    ? req.body.platforms.map((p) => String(p).toLowerCase()).filter((p) => SOCIAL_PLATFORMS.includes(p))
    : [];
  const scheduledAt = req.body?.scheduled_at ? new Date(req.body.scheduled_at) : null;

  if (!imageBase64 && !publicUrl) {
    return res.status(400).json({ error: 'Provide image_base64 or public_image_url.' });
  }
  if (!platforms.length) {
    return res.status(400).json({ error: 'Select at least one platform.' });
  }
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduled_at.' });
  }

  const isFuture = scheduledAt && scheduledAt.getTime() > Date.now() + 60_000;
  const initialStatus = isFuture ? 'scheduled' : 'publishing';

  let postRow;
  try {
    const r = await db.query(
      `INSERT INTO social_posts
         (church_id, branch_id, image_base64, image_mime, caption, platforms,
          status, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, status, scheduled_at, created_at, image_base64, image_mime, caption, platforms`,
      [req.church.id, req.activeBranchId || null, imageBase64, imageMime, caption,
       JSON.stringify(platforms), initialStatus,
       scheduledAt && isFuture ? scheduledAt : null, req.staff?.email || null],
    );
    postRow = r.rows[0];
  } catch (e) {
    console.error('POST /api/church-admin/social/posts (insert):', e.code, e.message);
    return res.status(500).json({ error: 'Failed to queue post.' });
  }

  // Scheduled in the future → just return; the worker will publish later.
  if (isFuture) {
    return res.status(202).json({ post: { ...postRow, image_base64: undefined, platforms, results: {} } });
  }

  const baseUrl = publicApiBase(req);
  const { results, status: finalStatus } = await dispatchSocialPost({
    postRow,
    churchId:  req.church.id,
    branchId:  req.activeBranchId,
    actor:     req.staff,
    baseUrl,
    providedPublicUrl: publicUrl,
  });

  res.status(201).json({
    post: {
      id:           postRow.id,
      status:       finalStatus,
      platforms,
      results,
      created_at:   postRow.created_at,
      published_at: new Date().toISOString(),
    },
  });
});

// Once-a-minute worker. The dispatch helper flips status to 'publishing'
// before fan-out, so even if this fires on two replicas the first wins.
// Disable with SOCIAL_SCHEDULER=off (useful for tests / one-off scripts).
async function runSocialScheduler() {
  if (process.env.SOCIAL_SCHEDULER === 'off') return;
  let due;
  try {
    const r = await db.query(
      `SELECT id, church_id, branch_id, image_base64, image_mime, caption,
              platforms, scheduled_at, created_by
         FROM social_posts
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 10`,
    );
    due = r.rows;
  } catch (e) {
    console.error('socialScheduler (select):', e.code, e.message);
    return;
  }
  for (const row of due) {
    try {
      await dispatchSocialPost({
        postRow:  row,
        churchId: row.church_id,
        branchId: row.branch_id,
        actor:    { email: row.created_by, name: null },
        baseUrl:  publicApiBase(null),
        providedPublicUrl: null,
      });
    } catch (e) {
      console.error('socialScheduler (dispatch):', row.id, e.message);
    }
  }
}

// Start the worker once when this module is first required.
function startScheduler() {
  setInterval(runSocialScheduler, 60_000);
}

module.exports = router;
module.exports.startScheduler = startScheduler;
