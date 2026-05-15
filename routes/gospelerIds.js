// routes/gospelerIds.js
// Per-user digital Christian identity ("Gospeler ID"). One active row per
// email in gospeler_ids; superseded rows are archived to gospeler_id_history
// as JSONB snapshots so the audit trail (and historical QR scans) survive
// any later edits.
//
// Trust model — Phase 1: same email-keyed convention used by routes/profile.js
// (caller supplies the email; the mobile app reads it from AsyncStorage after
// login). The verify endpoint is public by design: any church kiosk / event
// scanner can resolve a QR token without holding an admin key.
//
// ID format
//   • gospeler_code  — human-readable, brandable. `GSP-YYYY-XXXXXXXX`
//                      (8 chars from a 32-char unambiguous alphabet ≈ 10^12 / yr).
//   • id             — opaque random token (crypto.randomUUID). This is what
//                      the QR encodes. Keeping it separate from gospeler_code
//                      means the code can be printed on physical material
//                      without leaking a scan-equivalent token.
//
// Regeneration triggers
//   When full_name / church_name / church_branch / membership_role change on
//   PUT we archive the current row, bump `version`, mint a new gospeler_code
//   + id, and return the new card. Non-material fields (phone, photo, gender,
//   DOB, country, state) update in place with no regen.

const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { isValidEmail } = require('../utils/helpers');

const router = express.Router();

// Same alphabet used by certificate codes — skips 0/O/I/1 to avoid visual
// confusion when an ID is read off a printed badge.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MEMBERSHIP_ROLES = ['member', 'worker', 'pastor', 'youth', 'leader', 'minister'];

// Fields whose value-change forces a regeneration of gospeler_code + QR token
// (and archives the previous row). A change in church_status / assembly is
// material the same way church_name / branch is — the QR encodes verifiable
// identity and the ID should rotate when that identity changes. Region and
// district are derived from assembly so they're not in the trigger set;
// changing them without changing assembly is treated as a soft update.
const MATERIAL_FIELDS = [
  'full_name', 'church_name', 'church_branch', 'membership_role',
  'church_status', 'assembly',
];

function randSuffix(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

function buildGospelerCode() {
  return `GSP-${new Date().getFullYear()}-${randSuffix(8)}`;
}

// Mint a (gospeler_code, id) pair. Retries on UNIQUE collision so the caller
// doesn't have to think about it — UNIQUE on gospeler_code is the final guard.
async function mintUniqueCode(maxAttempts = 6) {
  for (let i = 0; i < maxAttempts; i++) {
    const gospeler_code = buildGospelerCode();
    const id            = crypto.randomUUID();
    const conflict = await db.query(
      'SELECT 1 FROM gospeler_ids WHERE gospeler_code = $1 OR id = $2 LIMIT 1',
      [gospeler_code, id]
    );
    if (!conflict.rows.length) return { gospeler_code, id };
  }
  throw new Error('Could not generate a unique gospeler_code after retries.');
}

// Map a DB row to the JSON shape the mobile app expects. Hides any internal
// columns we don't want to leak (none today, but future-proofing).
function toPublic(row) {
  if (!row) return null;
  return {
    id:              row.id,
    email:           row.email,
    gospeler_code:   row.gospeler_code,
    version:         row.version,
    full_name:       row.full_name,
    phone:           row.phone,
    church_name:     row.church_name,
    church_branch:   row.church_branch,
    country:         row.country,
    state_province:  row.state_province,
    gender:          row.gender,
    date_of_birth:   row.date_of_birth,
    photo_base64:    row.photo_base64,
    membership_role: row.membership_role,
    // Extended (webapp-aligned) membership profile fields. Null on rows
    // created before the migration; the mobile form treats null as "ask".
    title:           row.title,
    church_status:   row.church_status,
    age_bracket:     row.age_bracket,
    city:            row.city,
    region:          row.region,
    district:        row.district,
    assembly:        row.assembly,
    verified:        row.verified,
    issued_at:       row.issued_at,
    updated_at:      row.updated_at,
  };
}

// Normalise a payload from the client. Returns only the fields that were
// actually sent (undefined ones drop out) so PUT can do partial updates.
function normaliseBody(body) {
  const out = {};
  const trim = (v) => (typeof v === 'string' ? v.trim() : v);
  if (body.full_name       !== undefined) out.full_name       = trim(body.full_name) || null;
  if (body.phone           !== undefined) out.phone           = trim(body.phone) || null;
  if (body.church_name     !== undefined) out.church_name     = trim(body.church_name) || null;
  if (body.church_branch   !== undefined) out.church_branch   = trim(body.church_branch) || null;
  if (body.country         !== undefined) out.country         = trim(body.country) || null;
  if (body.state_province  !== undefined) out.state_province  = trim(body.state_province) || null;
  if (body.gender          !== undefined) out.gender          = trim(body.gender) || null;
  if (body.date_of_birth   !== undefined) out.date_of_birth   = body.date_of_birth || null;
  if (body.photo_base64    !== undefined) out.photo_base64    = body.photo_base64 || null;
  if (body.membership_role !== undefined) {
    const role = String(body.membership_role || '').toLowerCase();
    out.membership_role = MEMBERSHIP_ROLES.includes(role) ? role : 'member';
  }
  // Extended profile (webapp-aligned). All optional, all soft-validated:
  // we normalise + length-cap and accept anything reasonable. `church_status`
  // is the one strict enum — anything outside the 28-code list drops back to
  // null rather than silently coercing, because a fabricated role code is
  // worse than a missing one for downstream reporting.
  if (body.title         !== undefined) out.title         = trim(body.title)         ? String(body.title).slice(0, 40)  : null;
  if (body.age_bracket   !== undefined) out.age_bracket   = trim(body.age_bracket)   ? String(body.age_bracket).slice(0, 40)  : null;
  if (body.city          !== undefined) out.city          = trim(body.city)          ? String(body.city).slice(0, 120) : null;
  if (body.region        !== undefined) out.region        = trim(body.region)        ? String(body.region).slice(0, 120) : null;
  if (body.district      !== undefined) out.district      = trim(body.district)      ? String(body.district).slice(0, 120) : null;
  if (body.assembly      !== undefined) out.assembly      = trim(body.assembly)      ? String(body.assembly).slice(0, 200) : null;
  // church_status used to be strict-validated against the 28-code STATUSES
  // enum. Loosened to free-text so users whose denomination role isn't in
  // the canonical list aren't silently dropped to null. Still upper-cased
  // and length-capped to keep reporting buckets coherent.
  if (body.church_status !== undefined) {
    const code = String(body.church_status || '').trim().toUpperCase().slice(0, 20);
    out.church_status = code || null;
  }
  return out;
}

// ── GET /api/gospeler-id/:email ──────────────────────────────────────────────
// Fetch the current active Gospeler ID for a user. 404 if none.
router.get('/api/gospeler-id/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
  try {
    const r = await db.query('SELECT * FROM gospeler_ids WHERE LOWER(email) = $1', [email]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(toPublic(r.rows[0]));
  } catch (e) {
    console.error('GET gospeler-id:', e.message);
    res.status(500).json({ error: 'Failed to fetch Gospeler ID.' });
  }
});

// ── GET /api/gospeler-id/code/:gospelerCode ──────────────────────────────────
// Public lookup by the human-readable gospeler_code (e.g. GSP-2026-AB12CD34).
// Used by the registration webapp to auto-fill an attendee form when the user
// types in their ID. Case-insensitive. Returns the same shape as the
// email-keyed GET, minus photo_base64 (too large for an autofill payload).
router.get('/api/gospeler-id/code/:gospelerCode', async (req, res) => {
  const code = String(req.params.gospelerCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Missing gospeler_code.' });
  try {
    const r = await db.query(
      'SELECT * FROM gospeler_ids WHERE UPPER(gospeler_code) = $1',
      [code]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const { photo_base64, ...rest } = toPublic(r.rows[0]);
    res.json(rest);
  } catch (e) {
    console.error('GET gospeler-id by code:', e.message);
    res.status(500).json({ error: 'Failed to fetch Gospeler ID.' });
  }
});

// ── POST /api/gospeler-id/:email ─────────────────────────────────────────────
// Generate a brand-new Gospeler ID for a user. Fails 409 if one already
// exists for the email — the client should call PUT (or the regenerate
// endpoint) instead.
router.post('/api/gospeler-id/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

  const body = normaliseBody(req.body || {});
  if (!body.full_name) return res.status(400).json({ error: 'Full name is required.' });

  try {
    const existing = await db.query(
      'SELECT id FROM gospeler_ids WHERE LOWER(email) = $1',
      [email]
    );
    if (existing.rows.length) {
      return res.status(409).json({
        error: 'already_exists',
        message: 'A Gospeler ID already exists for this account. Use PUT to update or regenerate.',
      });
    }

    const { gospeler_code, id } = await mintUniqueCode();

    const r = await db.query(
      `INSERT INTO gospeler_ids
         (id, email, gospeler_code, version, full_name, phone, church_name, church_branch,
          country, state_province, gender, date_of_birth, photo_base64, membership_role,
          title, church_status, age_bracket, city, region, district, assembly)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        id, email, gospeler_code,
        body.full_name, body.phone || null, body.church_name || null, body.church_branch || null,
        body.country || null, body.state_province || null, body.gender || null,
        body.date_of_birth || null, body.photo_base64 || null,
        body.membership_role || 'member',
        body.title || null, body.church_status || null, body.age_bracket || null,
        body.city || null, body.region || null, body.district || null, body.assembly || null,
      ]
    );
    res.status(201).json(toPublic(r.rows[0]));
  } catch (e) {
    console.error('POST gospeler-id:', e.message);
    res.status(500).json({ error: 'Failed to generate Gospeler ID.' });
  }
});

// Archive the current row to gospeler_id_history. Caller must have already
// locked / read the current row.
async function archiveCurrent(currentRow, reason) {
  await db.query(
    `INSERT INTO gospeler_id_history (email, gospeler_code, version, snapshot, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [currentRow.email, currentRow.gospeler_code, currentRow.version, currentRow, reason || 'update']
  );
}

// ── PUT /api/gospeler-id/:email ──────────────────────────────────────────────
// Partial update. If any of the material fields changes value, archive the
// current row, mint a new gospeler_code + id, bump version. Otherwise update
// in place.
router.put('/api/gospeler-id/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

  const patch = normaliseBody(req.body || {});
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update.' });

  try {
    const cur = await db.query('SELECT * FROM gospeler_ids WHERE LOWER(email) = $1', [email]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not_found' });
    const current = cur.rows[0];

    // Detect material changes — null vs empty-string treated as equal.
    const eq = (a, b) => (a == null ? '' : String(a)) === (b == null ? '' : String(b));
    const materialChange = MATERIAL_FIELDS.some(
      (f) => patch[f] !== undefined && !eq(patch[f], current[f])
    );

    // Build a merged "next" record so the new row carries forward values the
    // patch didn't touch.
    const next = { ...current, ...patch };

    if (materialChange) {
      await archiveCurrent(current, 'material_change');
      const { gospeler_code, id } = await mintUniqueCode();
      const r = await db.query(
        `UPDATE gospeler_ids SET
            id              = $1,
            gospeler_code   = $2,
            version         = version + 1,
            full_name       = $3,
            phone           = $4,
            church_name     = $5,
            church_branch   = $6,
            country         = $7,
            state_province  = $8,
            gender          = $9,
            date_of_birth   = $10,
            photo_base64    = $11,
            membership_role = $12,
            title           = $13,
            church_status   = $14,
            age_bracket     = $15,
            city            = $16,
            region          = $17,
            district        = $18,
            assembly        = $19,
            verified        = FALSE,
            updated_at      = NOW()
          WHERE LOWER(email) = $20
          RETURNING *`,
        [
          id, gospeler_code, next.full_name, next.phone, next.church_name, next.church_branch,
          next.country, next.state_province, next.gender, next.date_of_birth, next.photo_base64,
          next.membership_role || 'member',
          next.title, next.church_status, next.age_bracket,
          next.city, next.region, next.district, next.assembly,
          email,
        ]
      );
      return res.json({ ...toPublic(r.rows[0]), regenerated: true });
    }

    // Soft update — no regen. Touches every editable field that ISN'T in
    // MATERIAL_FIELDS so the user can correct typos in their address,
    // contact info, or denominational metadata without rotating their QR.
    const r = await db.query(
      `UPDATE gospeler_ids SET
          phone          = $1,
          country        = $2,
          state_province = $3,
          gender         = $4,
          date_of_birth  = $5,
          photo_base64   = $6,
          title          = $7,
          age_bracket    = $8,
          city           = $9,
          region         = $10,
          district       = $11,
          updated_at     = NOW()
        WHERE LOWER(email) = $12
        RETURNING *`,
      [
        next.phone, next.country, next.state_province, next.gender,
        next.date_of_birth, next.photo_base64,
        next.title, next.age_bracket, next.city, next.region, next.district,
        email,
      ]
    );
    res.json({ ...toPublic(r.rows[0]), regenerated: false });
  } catch (e) {
    console.error('PUT gospeler-id:', e.message);
    res.status(500).json({ error: 'Failed to update Gospeler ID.' });
  }
});

// ── POST /api/gospeler-id/:email/regenerate ──────────────────────────────────
// Explicit user-initiated regeneration. Same archive + new-code dance as a
// material PUT, but doesn't require any field changes. Useful for "lost my
// physical card / rotate my QR" flows.
router.post('/api/gospeler-id/:email/regenerate', async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
  const reason = String((req.body && req.body.reason) || 'user_requested').slice(0, 120);

  try {
    const cur = await db.query('SELECT * FROM gospeler_ids WHERE LOWER(email) = $1', [email]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not_found' });
    await archiveCurrent(cur.rows[0], reason);
    const { gospeler_code, id } = await mintUniqueCode();
    const r = await db.query(
      `UPDATE gospeler_ids SET
          id            = $1,
          gospeler_code = $2,
          version       = version + 1,
          verified      = FALSE,
          updated_at    = NOW()
        WHERE LOWER(email) = $3
        RETURNING *`,
      [id, gospeler_code, email]
    );
    res.json({ ...toPublic(r.rows[0]), regenerated: true });
  } catch (e) {
    console.error('regenerate gospeler-id:', e.message);
    res.status(500).json({ error: 'Failed to regenerate Gospeler ID.' });
  }
});

// ── GET /api/gospeler-id/:email/history ──────────────────────────────────────
router.get('/api/gospeler-id/:email/history', async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
  try {
    const r = await db.query(
      `SELECT id, email, gospeler_code, version, reason, retired_at
         FROM gospeler_id_history
        WHERE LOWER(email) = $1
        ORDER BY version DESC
        LIMIT 50`,
      [email]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('history gospeler-id:', e.message);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// ── GET /api/gospeler-id/verify/:token ───────────────────────────────────────
// Public verification endpoint. The token here is gospeler_ids.id (the random
// UUID embedded in the QR), NOT the user-facing gospeler_code. Returns just
// enough to confirm the card is real + show the bearer's church identity.
router.get('/api/gospeler-id/verify/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing token.' });

  const scanContext = String(req.query.context || 'unknown').slice(0, 40);
  const scannedBy   = String(req.query.scanner || '').slice(0, 255) || null;

  try {
    const r = await db.query(
      `SELECT gospeler_code, full_name, church_name, church_branch, membership_role,
              photo_base64, verified, issued_at
         FROM gospeler_ids
        WHERE id = $1`,
      [token]
    );

    if (!r.rows.length) {
      await db.query(
        `INSERT INTO gospeler_verification_logs
           (gospeler_code, scanned_by, scan_context, result, metadata)
         VALUES ($1, $2, $3, 'not_found', $4)`,
        ['', scannedBy, scanContext, { token: token.slice(0, 16) }]
      );
      return res.status(404).json({ error: 'not_found' });
    }

    const row = r.rows[0];
    await db.query(
      `INSERT INTO gospeler_verification_logs
         (gospeler_code, scanned_by, scan_context, result, metadata)
       VALUES ($1, $2, $3, 'verified', $4)`,
      [row.gospeler_code, scannedBy, scanContext, {}]
    );

    res.json({
      verified:        true,
      gospeler_code:   row.gospeler_code,
      full_name:       row.full_name,
      church_name:     row.church_name,
      church_branch:   row.church_branch,
      membership_role: row.membership_role,
      photo_base64:    row.photo_base64,
      issued_at:       row.issued_at,
      badge:           row.verified ? 'church_verified' : 'self_attested',
    });
  } catch (e) {
    console.error('verify gospeler-id:', e.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

module.exports = router;
