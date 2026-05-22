// routes/churches.js
// Super-admin church directory + manual creation/edit/delete + teacher
// assignment + the public lookup the teacher signup form hits.

const express = require('express');
const db = require('../db');
const { adminAuth, churchAuth } = require('../middleware/auth');
const { isValidEmail, randCode, randToken } = require('../utils/helpers');

const router = express.Router();

router.post('/api/admin/churches', adminAuth, async (req, res) => {
  const { name, location, admin_email } = req.body || {};
  if (!name || !admin_email) return res.status(400).json({ error: 'name and admin_email required.' });
  if (!isValidEmail(admin_email))         return res.status(400).json({ error: 'Invalid admin_email.' });
  try {
    let inviteCode, attempts = 0;
    while (attempts++ < 10) {
      inviteCode = randCode(8);
      const dup = await db.query('SELECT 1 FROM churches WHERE invite_code = $1', [inviteCode]);
      if (!dup.rows.length) break;
    }
    const adminToken = randToken();
    const r = await db.query(`
      INSERT INTO churches (name, location, admin_email, admin_token, invite_code)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, location, admin_email, invite_code, admin_token, created_at
    `, [name.trim(), (location || '').trim() || null, admin_email.toLowerCase(), adminToken, inviteCode]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('POST /api/admin/churches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create church.' });
  }
});

router.put('/api/admin/churches/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid church id.' });
  const { name, location, admin_email } = req.body || {};
  if (admin_email && !isValidEmail(admin_email)) {
    return res.status(400).json({ error: 'Invalid admin_email.' });
  }
  const sets = [];
  const params = [];
  if (typeof name === 'string') {
    const v = name.trim();
    if (!v) return res.status(400).json({ error: 'name cannot be empty.' });
    params.push(v); sets.push(`name = $${params.length}`);
  }
  if (typeof location === 'string') {
    params.push(location.trim() || null); sets.push(`location = $${params.length}`);
  }
  if (typeof admin_email === 'string') {
    params.push(admin_email.trim().toLowerCase()); sets.push(`admin_email = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No editable fields supplied.' });
  params.push(id);
  try {
    const r = await db.query(
      `UPDATE churches SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, location, admin_email, invite_code, created_at,
                 COALESCE(approval_status, 'approved') AS approval_status`,
      params,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Church not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/churches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update church.' });
  }
});

router.delete('/api/admin/churches/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid church id.' });
  const confirmed = req.query.confirm === '1' || req.body?.confirm === true;
  try {
    const church = await db.query(
      `SELECT id, name, location, admin_email FROM churches WHERE id = $1`, [id],
    );
    if (church.rowCount === 0) return res.status(404).json({ error: 'Church not found.' });

    const [{ rows: t }, { rows: cl }, { rows: st }] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n FROM users   WHERE church_id = $1 AND role = 'teacher'`, [id]),
      db.query(`SELECT COUNT(*)::int AS n FROM classes WHERE church_id = $1`, [id]),
      db.query(`SELECT COUNT(*)::int AS n FROM students WHERE church_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    const preview = {
      church:   church.rows[0],
      teachers: t[0].n,
      classes:  cl[0].n,
      students: st[0].n,
    };
    if (!confirmed) {
      return res.json({ ok: false, preview, message: 'Pass ?confirm=1 to actually delete.' });
    }

    await db.query('DELETE FROM churches WHERE id = $1', [id]);
    res.json({ ok: true, deleted: preview });
  } catch (e) {
    console.error('DELETE /api/admin/churches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete church.' });
  }
});

// Super-admin lists all churches (with member counts).
router.get('/api/admin/churches', adminAuth, async (req, res) => {
  const includeToken = req.query.include === 'token';
  const wantAll = req.query.status === 'all';
  try {
    const r = await db.query(`
      SELECT c.id, c.name, c.location, c.admin_email, c.invite_code, c.created_at,
             COALESCE(c.approval_status, 'approved') AS approval_status${includeToken ? ', c.admin_token' : ''},
             (SELECT COUNT(*) FROM users    WHERE church_id = c.id AND role = 'teacher') AS teachers,
             (SELECT COUNT(*) FROM classes  WHERE church_id = c.id)                       AS classes
        FROM churches c
       ${wantAll ? '' : "WHERE COALESCE(c.approval_status, 'approved') = 'approved'"}
       ORDER BY c.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/admin/teachers', adminAuth, async (req, res) => {
  const { church } = req.query;
  try {
    let sql = `
      SELECT u.id, u.email, u.full_name, u.church_id, u.created_at,
             c.name AS church_name,
             (SELECT COUNT(*) FROM classes WHERE teacher_email = u.email) AS classes,
             (SELECT MAX(awarded_at) FROM teacher_marks WHERE awarded_by = u.email) AS last_active
        FROM users u
        LEFT JOIN churches c ON c.id = u.church_id
       WHERE u.role = 'teacher'`;
    const params = [];
    if (church === 'none') {
      sql += ' AND u.church_id IS NULL';
    } else if (church) {
      params.push(church);
      sql += ` AND u.church_id = $${params.length}`;
    }
    sql += ' ORDER BY u.created_at DESC';
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/teachers/:email/assign', adminAuth, async (req, res) => {
  const { email } = req.params;
  const { church_id } = req.body || {};
  if (!church_id) return res.status(400).json({ error: 'church_id required.' });
  try {
    const u = await db.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND role=$2', [email, 'teacher']);
    if (!u.rows.length) return res.status(404).json({ error: 'Teacher not found.' });
    const c = await db.query('SELECT id FROM churches WHERE id = $1', [church_id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Church not found.' });

    await db.query('UPDATE users SET church_id = $1 WHERE LOWER(email) = LOWER($2)', [church_id, email]);
    const cls   = await db.query('UPDATE classes        SET church_id = $1 WHERE LOWER(teacher_email) = LOWER($2) AND church_id IS DISTINCT FROM $1 RETURNING id', [church_id, email]);
    const att   = await db.query('UPDATE attendance     SET church_id = $1 WHERE LOWER(marked_by)     = LOWER($2) AND church_id IS DISTINCT FROM $1 RETURNING id', [church_id, email]);
    const marks = await db.query('UPDATE teacher_marks  SET church_id = $1 WHERE LOWER(awarded_by)    = LOWER($2) AND church_id IS DISTINCT FROM $1 RETURNING id', [church_id, email]);
    res.json({ ok: true, backfilled: { classes: cls.rowCount, attendance: att.rowCount, marks: marks.rowCount } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/church/me', churchAuth, (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const { admin_token, ...safe } = req.church;
  res.json(safe);
});

// Public church directory — used by EventDetails / TicketBadge to show the
// host church on a public page, and by the admin ChurchSwitcher in the nav.
// Returns approved churches only and strips admin_email/admin_token/etc.
// so nothing sensitive leaks to anonymous viewers.
router.get('/api/churches', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, location, invite_code, created_at
         FROM churches
        WHERE COALESCE(approval_status, 'approved') = 'approved'
        ORDER BY created_at DESC`,
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/churches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load churches.' });
  }
});

router.get('/api/churches/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid church id.' });
  try {
    const r = await db.query(
      `SELECT id, name, location, invite_code, created_at
         FROM churches
        WHERE id = $1
          AND COALESCE(approval_status, 'approved') = 'approved'`,
      [id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Church not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('GET /api/churches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load church.' });
  }
});

router.get('/api/church/by-code/:code', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, name, location FROM churches WHERE invite_code = $1',
      [req.params.code.toUpperCase()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown church code.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
