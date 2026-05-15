// routes/members.js
// Members + families + worker assignments. All routes scoped by churchAuth;
// branch_id defaults inherit from x-branch-id header but can be overridden
// per-call via ?branch_id query param or body field.

const express = require('express');
const db = require('../db');
const { churchAuth } = require('../middleware/auth');
const { logActivity } = require('../middleware/activity');

const router = express.Router();

const MEMBER_STATUSES = ['visitor', 'first_timer', 'member', 'inactive'];
const FAMILY_ROLES    = ['head', 'spouse', 'child', 'dependent', 'other'];

// Returns the columns safe to round-trip to the client. Strips photo_base64
// unless `withPhoto` is true (photos can be megabytes; keep list endpoints lean).
function memberCols(withPhoto = false) {
  return `m.id, m.church_id, m.branch_id, m.family_id, m.family_role,
          m.first_name, m.last_name, m.email, m.phone,
          m.gender, m.date_of_birth, m.marital_status, m.address,
          m.occupation, m.status, m.joined_at, m.notes,
          m.created_at, m.updated_at${withPhoto ? ', m.photo_base64' : ''}`;
}

function memberBody(body) {
  return {
    first_name:     body.first_name != null ? String(body.first_name).trim() || null : undefined,
    last_name:      body.last_name  != null ? String(body.last_name).trim()  || null : undefined,
    email:          body.email      != null ? String(body.email).toLowerCase().trim() || null : undefined,
    phone:          body.phone      != null ? String(body.phone).trim() || null : undefined,
    gender:         body.gender     != null ? String(body.gender) || null : undefined,
    date_of_birth:  body.date_of_birth || null,
    marital_status: body.marital_status != null ? String(body.marital_status) || null : undefined,
    address:        body.address != null ? String(body.address) || null : undefined,
    occupation:     body.occupation != null ? String(body.occupation) || null : undefined,
    status:         body.status != null ? String(body.status) : undefined,
    joined_at:      body.joined_at || null,
    notes:          body.notes != null ? String(body.notes) || null : undefined,
    branch_id:      body.branch_id != null ? parseInt(body.branch_id, 10) : undefined,
    family_id:      body.family_id !== undefined
      ? (body.family_id == null ? null : parseInt(body.family_id, 10))
      : undefined,
    family_role:    body.family_role !== undefined
      ? (body.family_role == null ? null : String(body.family_role))
      : undefined,
  };
}

router.get('/api/church-admin/members', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const status = String(req.query.status || 'all').toLowerCase();
  if (status !== 'all' && !MEMBER_STATUSES.includes(status))
    return res.status(400).json({ error: 'Invalid status filter.' });

  const params = [req.church.id];
  let where = 'WHERE m.church_id = $1';

  const branchId = req.query.branch_id != null
    ? parseInt(req.query.branch_id, 10)
    : req.activeBranchId;
  if (Number.isFinite(branchId) && branchId) {
    params.push(branchId);
    where += ` AND m.branch_id = $${params.length}`;
  }
  if (status !== 'all') {
    params.push(status);
    where += ` AND m.status = $${params.length}`;
  }
  if (req.query.family_id) {
    const fid = parseInt(req.query.family_id, 10);
    if (Number.isFinite(fid)) {
      params.push(fid);
      where += ` AND m.family_id = $${params.length}`;
    }
  }
  if (String(req.query.worker || '').toLowerCase() === 'true') {
    where += ` AND EXISTS (SELECT 1 FROM worker_assignments wa
                            WHERE wa.member_id = m.id AND wa.ended_at IS NULL)`;
  }
  if (req.query.q) {
    const term = `%${String(req.query.q).toLowerCase()}%`;
    params.push(term);
    where += ` AND (
      LOWER(m.first_name) LIKE $${params.length} OR
      LOWER(m.last_name)  LIKE $${params.length} OR
      LOWER(COALESCE(m.email, '')) LIKE $${params.length} OR
      COALESCE(m.phone, '') LIKE $${params.length}
    )`;
  }
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT ${memberCols(false)},
              f.name AS family_name,
              b.name AS branch_name,
              (SELECT COUNT(*)::int FROM worker_assignments wa
                WHERE wa.member_id = m.id AND wa.ended_at IS NULL) AS active_assignments
         FROM members m
         LEFT JOIN families f ON f.id = m.family_id
         LEFT JOIN branches b ON b.id = m.branch_id
         ${where}
         ORDER BY m.created_at DESC
         LIMIT $${params.length}`,
      params,
    );
    res.json({ members: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('GET /api/church-admin/members:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load members.' });
  }
});

router.get('/api/church-admin/members/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const [memberR, assignR, familyR] = await Promise.all([
      db.query(
        `SELECT ${memberCols(true)},
                f.name AS family_name,
                b.name AS branch_name
           FROM members m
           LEFT JOIN families f ON f.id = m.family_id
           LEFT JOIN branches b ON b.id = m.branch_id
          WHERE m.id = $1 AND m.church_id = $2`,
        [id, req.church.id],
      ),
      db.query(
        `SELECT id, department, role, started_at, ended_at, notes, created_at
           FROM worker_assignments
          WHERE member_id = $1
          ORDER BY ended_at IS NULL DESC, started_at DESC`,
        [id],
      ),
      db.query(
        `SELECT id, first_name, last_name, family_role
           FROM members
          WHERE family_id = (SELECT family_id FROM members WHERE id = $1)
            AND family_id IS NOT NULL
            AND id <> $1
          ORDER BY family_role NULLS LAST, first_name`,
        [id],
      ),
    ]);
    if (!memberR.rows.length) return res.status(404).json({ error: 'Member not found.' });
    res.json({
      member:      memberR.rows[0],
      assignments: assignR.rows,
      family_members: familyR.rows,
    });
  } catch (e) {
    console.error('GET /api/church-admin/members/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load member.' });
  }
});

router.post('/api/church-admin/members', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const b = memberBody(req.body || {});
  if (!b.first_name) return res.status(400).json({ error: 'first_name is required.' });
  if (b.status && !MEMBER_STATUSES.includes(b.status))
    return res.status(400).json({ error: 'Invalid status.' });
  if (b.family_role && !FAMILY_ROLES.includes(b.family_role))
    return res.status(400).json({ error: 'Invalid family_role.' });

  let branchId = b.branch_id;
  if (!branchId) {
    if (req.activeBranchId) {
      branchId = req.activeBranchId;
    } else {
      const hq = await db.query(
        `SELECT id FROM branches WHERE church_id = $1 AND is_headquarters = TRUE LIMIT 1`,
        [req.church.id],
      );
      branchId = hq.rows[0]?.id || null;
    }
  } else {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branchId, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
  }
  if (b.family_id) {
    const ok = await db.query('SELECT 1 FROM families WHERE id = $1 AND church_id = $2', [b.family_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Family not in your church.' });
  }

  try {
    const r = await db.query(
      `INSERT INTO members
        (church_id, branch_id, family_id, family_role,
         first_name, last_name, email, phone,
         gender, date_of_birth, marital_status, address, occupation,
         status, joined_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               COALESCE($14,'member'), COALESCE($15, CURRENT_DATE), $16)
       RETURNING ${memberCols(false).replace(/m\./g, '')}`,
      [
        req.church.id, branchId, b.family_id ?? null, b.family_role ?? null,
        b.first_name, b.last_name ?? null, b.email ?? null, b.phone ?? null,
        b.gender ?? null, b.date_of_birth, b.marital_status ?? null,
        b.address ?? null, b.occupation ?? null,
        b.status ?? null, b.joined_at, b.notes ?? null,
      ],
    );
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.created', entity_type: 'member', entity_id: m.id,
      summary: `Registered ${m.first_name} ${m.last_name || ''}`.trim() + ` as ${m.status}`,
    });
    res.status(201).json({ member: m });
  } catch (e) {
    console.error('POST /api/church-admin/members:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create member.' });
  }
});

router.put('/api/church-admin/members/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const b = memberBody(req.body || {});
  if (b.status && !MEMBER_STATUSES.includes(b.status))
    return res.status(400).json({ error: 'Invalid status.' });
  if (b.family_role && !FAMILY_ROLES.includes(b.family_role))
    return res.status(400).json({ error: 'Invalid family_role.' });
  if (b.branch_id) {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [b.branch_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
  }
  if (b.family_id) {
    const ok = await db.query('SELECT 1 FROM families WHERE id = $1 AND church_id = $2', [b.family_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Family not in your church.' });
  }
  try {
    const r = await db.query(
      `UPDATE members SET
         first_name     = COALESCE($1, first_name),
         last_name      = COALESCE($2, last_name),
         email          = COALESCE($3, email),
         phone          = COALESCE($4, phone),
         gender         = COALESCE($5, gender),
         date_of_birth  = COALESCE($6, date_of_birth),
         marital_status = COALESCE($7, marital_status),
         address        = COALESCE($8, address),
         occupation     = COALESCE($9, occupation),
         status         = COALESCE($10, status),
         joined_at      = COALESCE($11, joined_at),
         notes          = COALESCE($12, notes),
         branch_id      = COALESCE($13, branch_id),
         family_id      = CASE WHEN $15::int = 1 THEN $14::int ELSE family_id END,
         family_role    = CASE WHEN $17::int = 1 THEN $16 ELSE family_role END
       WHERE id = $18 AND church_id = $19
       RETURNING ${memberCols(false).replace(/m\./g, '')}`,
      [
        b.first_name ?? null, b.last_name ?? null, b.email ?? null, b.phone ?? null,
        b.gender ?? null, b.date_of_birth, b.marital_status ?? null,
        b.address ?? null, b.occupation ?? null, b.status ?? null,
        b.joined_at, b.notes ?? null, b.branch_id ?? null,
        b.family_id ?? null, b.family_id !== undefined ? 1 : 0,
        b.family_role ?? null, b.family_role !== undefined ? 1 : 0,
        id, req.church.id,
      ],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.updated', entity_type: 'member', entity_id: m.id,
      summary: `Updated ${m.first_name} ${m.last_name || ''}`.trim(),
    });
    res.json({ member: m });
  } catch (e) {
    console.error('PUT /api/church-admin/members/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update member.' });
  }
});

router.delete('/api/church-admin/members/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `DELETE FROM members WHERE id = $1 AND church_id = $2
       RETURNING id, first_name, last_name, branch_id`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.deleted', entity_type: 'member', entity_id: id,
      summary: `Removed ${m.first_name} ${m.last_name || ''}`.trim(),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/members/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete member.' });
  }
});

router.post('/api/church-admin/members/:id/photo', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const photo = req.body?.photo_base64;
  if (photo != null && typeof photo !== 'string')
    return res.status(400).json({ error: 'photo_base64 must be a data URL string or null.' });
  try {
    const r = await db.query(
      `UPDATE members SET photo_base64 = $1
        WHERE id = $2 AND church_id = $3
        RETURNING id`,
      [photo || null, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/church-admin/members/:id/photo:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save photo.' });
  }
});

// Convenience: visitor → first_timer → member promote shortcut.
router.post('/api/church-admin/members/:id/promote', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `UPDATE members SET status = CASE status
          WHEN 'visitor'     THEN 'first_timer'
          WHEN 'first_timer' THEN 'member'
          ELSE status
        END
        WHERE id = $1 AND church_id = $2
        RETURNING id, first_name, last_name, status, branch_id`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.promoted', entity_type: 'member', entity_id: m.id,
      summary: `${m.first_name} ${m.last_name || ''} promoted to ${m.status}`.trim(),
    });
    res.json({ member: m });
  } catch (e) {
    console.error('POST /api/church-admin/members/:id/promote:', e.code, e.message);
    res.status(500).json({ error: 'Promote failed.' });
  }
});

// ── Families ───────────────────────────────────────────────────────────────
router.get('/api/church-admin/families', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const params = [req.church.id];
  let where = 'WHERE f.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND (f.branch_id = $${params.length} OR f.branch_id IS NULL)`;
  }
  try {
    const r = await db.query(
      `SELECT f.id, f.name, f.address, f.branch_id, f.notes, f.created_at,
              b.name AS branch_name,
              h.id AS head_id, h.first_name AS head_first, h.last_name AS head_last,
              (SELECT COUNT(*)::int FROM members m WHERE m.family_id = f.id) AS member_count
         FROM families f
         LEFT JOIN branches b ON b.id = f.branch_id
         LEFT JOIN members  h ON h.id = f.head_member_id
         ${where}
         ORDER BY f.name ASC`,
      params,
    );
    res.json({ families: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/families:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load families.' });
  }
});

router.get('/api/church-admin/families/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const [fam, members] = await Promise.all([
      db.query(
        `SELECT f.*, b.name AS branch_name,
                h.first_name AS head_first, h.last_name AS head_last
           FROM families f
           LEFT JOIN branches b ON b.id = f.branch_id
           LEFT JOIN members  h ON h.id = f.head_member_id
          WHERE f.id = $1 AND f.church_id = $2`,
        [id, req.church.id],
      ),
      db.query(
        `SELECT id, first_name, last_name, family_role, phone, email, status, joined_at
           FROM members
          WHERE family_id = $1
          ORDER BY family_role NULLS LAST, first_name`,
        [id],
      ),
    ]);
    if (!fam.rows.length) return res.status(404).json({ error: 'Family not found.' });
    res.json({ family: fam.rows[0], members: members.rows });
  } catch (e) {
    console.error('GET /api/church-admin/families/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load family.' });
  }
});

router.post('/api/church-admin/families', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required.' });
  const address = req.body?.address != null ? String(req.body.address) || null : null;
  const notes   = req.body?.notes   != null ? String(req.body.notes)   || null : null;
  const branch_id = req.body?.branch_id != null
    ? parseInt(req.body.branch_id, 10)
    : (req.activeBranchId || null);
  if (branch_id) {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branch_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
  }
  try {
    const r = await db.query(
      `INSERT INTO families (church_id, branch_id, name, address, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, address, branch_id, notes, created_at`,
      [req.church.id, branch_id, name, address, notes],
    );
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'family.created', entity_type: 'family', entity_id: r.rows[0].id,
      summary: `Created family ${r.rows[0].name}`,
    });
    res.status(201).json({ family: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/families:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create family.' });
  }
});

router.put('/api/church-admin/families/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const name    = req.body?.name    != null ? String(req.body.name).trim() : null;
  const address = req.body?.address != null ? String(req.body.address) || null : null;
  const notes   = req.body?.notes   != null ? String(req.body.notes)   || null : null;
  const head_member_id = req.body?.head_member_id !== undefined
    ? (req.body.head_member_id == null ? null : parseInt(req.body.head_member_id, 10))
    : undefined;
  try {
    if (head_member_id) {
      const ok = await db.query(
        `SELECT 1 FROM members WHERE id = $1 AND church_id = $2 AND family_id = $3`,
        [head_member_id, req.church.id, id],
      );
      if (!ok.rows.length) return res.status(400).json({ error: 'Head must already belong to this family.' });
    }
    const r = await db.query(
      `UPDATE families SET
         name           = COALESCE($1, name),
         address        = COALESCE($2, address),
         notes          = COALESCE($3, notes),
         head_member_id = CASE WHEN $5::int = 1 THEN $4::int ELSE head_member_id END
       WHERE id = $6 AND church_id = $7
       RETURNING id, name, address, branch_id, notes, head_member_id, created_at`,
      [name, address, notes, head_member_id ?? null, head_member_id !== undefined ? 1 : 0, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Family not found.' });
    if (head_member_id) {
      await db.query(
        `UPDATE members SET family_role = CASE WHEN id = $1 THEN 'head'
                                              WHEN family_role = 'head' THEN NULL
                                              ELSE family_role END
          WHERE family_id = $2`,
        [head_member_id, id],
      );
    }
    res.json({ family: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/families/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update family.' });
  }
});

router.delete('/api/church-admin/families/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    await db.query(
      `UPDATE members SET family_role = NULL WHERE family_id = $1`,
      [id],
    );
    const r = await db.query(
      `DELETE FROM families WHERE id = $1 AND church_id = $2 RETURNING id, name`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Family not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'family.deleted', entity_type: 'family', entity_id: id,
      summary: `Deleted family ${r.rows[0].name}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/families/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete family.' });
  }
});

// ── Worker / volunteer assignments ─────────────────────────────────────────
router.get('/api/church-admin/workers', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const includeEnded = String(req.query.include_ended || 'false') === 'true';
  const params = [req.church.id];
  let where = `WHERE wa.church_id = $1${includeEnded ? '' : ' AND wa.ended_at IS NULL'}`;
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND (wa.branch_id = $${params.length} OR wa.branch_id IS NULL)`;
  }
  try {
    const r = await db.query(
      `SELECT wa.id, wa.department, wa.role, wa.started_at, wa.ended_at, wa.notes,
              wa.member_id, wa.branch_id,
              m.first_name, m.last_name, m.email, m.phone,
              b.name AS branch_name
         FROM worker_assignments wa
         JOIN members m  ON m.id = wa.member_id
         LEFT JOIN branches b ON b.id = wa.branch_id
         ${where}
         ORDER BY wa.department ASC, wa.started_at DESC`,
      params,
    );
    res.json({ assignments: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/workers:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load workers.' });
  }
});

router.post('/api/church-admin/members/:id/assignments', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isFinite(memberId)) return res.status(400).json({ error: 'Invalid member id.' });
  const department = String(req.body?.department || '').trim();
  const role       = String(req.body?.role || 'member').trim() || 'member';
  const startedAt  = req.body?.started_at || null;
  const notes      = req.body?.notes != null ? String(req.body.notes) || null : null;
  if (!department) return res.status(400).json({ error: 'department is required.' });
  try {
    const member = await db.query(
      `SELECT id, branch_id FROM members WHERE id = $1 AND church_id = $2`,
      [memberId, req.church.id],
    );
    if (!member.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const r = await db.query(
      `INSERT INTO worker_assignments
        (member_id, church_id, branch_id, department, role, started_at, notes)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7)
       RETURNING id, department, role, started_at, ended_at, notes, member_id, branch_id, created_at`,
      [memberId, req.church.id, member.rows[0].branch_id, department, role, startedAt, notes],
    );
    logActivity({
      church_id: req.church.id, branch_id: member.rows[0].branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'worker.assigned', entity_type: 'worker', entity_id: r.rows[0].id,
      summary: `Assigned member #${memberId} to ${department} (${role})`,
    });
    res.status(201).json({ assignment: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/members/:id/assignments:', e.code, e.message);
    res.status(500).json({ error: 'Failed to assign.' });
  }
});

router.put('/api/church-admin/assignments/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const department = req.body?.department != null ? String(req.body.department).trim() : null;
  const role       = req.body?.role       != null ? String(req.body.role).trim() : null;
  const started_at = req.body?.started_at || null;
  const ended_at   = req.body?.ended_at !== undefined ? (req.body.ended_at || null) : undefined;
  const notes      = req.body?.notes != null ? String(req.body.notes) || null : null;
  try {
    const r = await db.query(
      `UPDATE worker_assignments SET
         department = COALESCE($1, department),
         role       = COALESCE($2, role),
         started_at = COALESCE($3, started_at),
         ended_at   = CASE WHEN $5::int = 1 THEN $4::date ELSE ended_at END,
         notes      = COALESCE($6, notes)
       WHERE id = $7 AND church_id = $8
       RETURNING id, department, role, started_at, ended_at, notes, member_id, branch_id, created_at`,
      [department, role, started_at, ended_at ?? null, ended_at !== undefined ? 1 : 0, notes, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found.' });
    res.json({ assignment: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/assignments/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update assignment.' });
  }
});

router.delete('/api/church-admin/assignments/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `DELETE FROM worker_assignments WHERE id = $1 AND church_id = $2
       RETURNING id, member_id, department`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'worker.unassigned', entity_type: 'worker', entity_id: id,
      summary: `Removed member #${r.rows[0].member_id} from ${r.rows[0].department}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/assignments/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to remove assignment.' });
  }
});

module.exports = router;
