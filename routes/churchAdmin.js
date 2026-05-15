// routes/churchAdmin.js
// Church-admin self-service signup/login + main-admin approval flow + mail
// pipeline health checks + teacher approval + the dashboard's bootstrap
// endpoint and CRUD for branches / staff / activity / KPI summaries.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { adminAuth, churchAuth, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../middleware/activity');
const { isValidEmail, randCode, randToken } = require('../utils/helpers');
const { sendApprovalEmail, sendRejectionEmail, sendMail } = require('../services/mailer');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN SELF-SERVICE SIGNUP / LOGIN
// Anyone can sign up via church-admin.html. New rows start as 'pending';
// the master admin must approve before login is allowed.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/church-admin/signup', async (req, res) => {
  const {
    church_name, location, contact_name,
    admin_email, phone, password,
  } = req.body || {};

  if (!church_name || !admin_email || !password)
    return res.status(400).json({ error: 'church_name, admin_email and password are required.' });
  if (!isValidEmail(admin_email))
    return res.status(400).json({ error: 'Invalid admin_email.' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    const dup = await db.query(
      'SELECT id, approval_status FROM churches WHERE admin_email = $1',
      [admin_email.toLowerCase()]
    );
    if (dup.rows.length) {
      const status = dup.rows[0].approval_status;
      const msg = status === 'pending'  ? 'An application with this email is already pending review.'
                : status === 'rejected' ? 'An earlier application with this email was rejected. Contact the main admin.'
                                        : 'An account with this email already exists. Sign in instead.';
      return res.status(409).json({ error: msg, status });
    }

    let inviteCode, attempts = 0;
    while (attempts++ < 10) {
      inviteCode = randCode(8);
      const dupCode = await db.query('SELECT 1 FROM churches WHERE invite_code = $1', [inviteCode]);
      if (!dupCode.rows.length) break;
    }
    const adminToken = randToken();
    const hash = await bcrypt.hash(password, 12);

    const r = await db.query(`
      INSERT INTO churches (
        name, location, admin_email, admin_token, invite_code,
        password_hash, contact_name, phone, approval_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id, name, admin_email, approval_status, created_at
    `, [
      church_name.trim(),
      (location     || '').trim() || null,
      admin_email.toLowerCase(),
      adminToken,
      inviteCode,
      hash,
      (contact_name || '').trim() || null,
      (phone        || '').trim() || null,
    ]);

    res.status(201).json({
      message: 'Application submitted. The main admin will review your church and approve access shortly.',
      church: r.rows[0],
    });
  } catch (e) {
    console.error('POST /api/church-admin/signup:', e.code, e.message);
    res.status(500).json({ error: 'Signup failed.' });
  }
});

router.post('/api/church-admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const r = await db.query(`
      SELECT id, name, location, admin_email, admin_token, invite_code,
             password_hash, approval_status, rejected_reason
        FROM churches
       WHERE admin_email = $1
    `, [String(email).toLowerCase()]);
    if (!r.rows.length)
      return res.status(401).json({ error: 'No church admin account with this email.' });

    const row = r.rows[0];
    if (!row.password_hash) {
      // Manually-created church (pre-self-service). They never set a password.
      return res.status(403).json({
        error: 'no_password',
        message: 'This church was created by the main admin and does not use a password. Use the admin token they gave you (paste it on the church-admin page header).',
      });
    }

    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    if (row.approval_status === 'pending') {
      return res.status(403).json({
        error: 'pending',
        message: 'Your application is still under review. You will be able to sign in once the main admin approves it.',
      });
    }
    if (row.approval_status === 'rejected') {
      return res.status(403).json({
        error: 'rejected',
        message: row.rejected_reason
          ? `Application rejected: ${row.rejected_reason}`
          : 'Application rejected. Contact the main admin.',
      });
    }

    res.json({
      message: 'Signed in.',
      admin_token: row.admin_token,
      church: {
        id:           row.id,
        name:         row.name,
        location:     row.location,
        admin_email:  row.admin_email,
        invite_code:  row.invite_code,
      },
    });
  } catch (e) {
    console.error('POST /api/church-admin/login:', e.code, e.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ADMIN — REVIEW + APPROVE / REJECT CHURCH APPLICATIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/admin/church-applications', adminAuth, async (req, res) => {
  const status = String(req.query.status || 'pending').toLowerCase();
  if (!['pending', 'approved', 'rejected', 'all'].includes(status))
    return res.status(400).json({ error: 'status must be pending|approved|rejected|all.' });
  try {
    const where  = status === 'all' ? '' : 'WHERE approval_status = $1';
    const params = status === 'all' ? [] : [status];
    const r = await db.query(`
      SELECT id, name, location, admin_email, contact_name, phone,
             invite_code, approval_status, approved_at, rejected_reason,
             rejected_at, created_at
        FROM churches
        ${where}
       ORDER BY created_at DESC
    `, params);
    res.json({ status, count: r.rows.length, applications: r.rows });
  } catch (e) {
    console.error('GET /api/admin/church-applications:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load applications.' });
  }
});

router.post('/api/admin/church-applications/:id/approve', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(`
      UPDATE churches
         SET approval_status = 'approved',
             approved_at     = NOW(),
             rejected_reason = NULL,
             rejected_at     = NULL
       WHERE id = $1
       RETURNING id, name, admin_email, contact_name, invite_code, admin_token, approval_status, approved_at
    `, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Application not found.' });
    const church = r.rows[0];

    // Approval has already committed; email failure is a soft warning, not a rollback.
    let mail;
    try {
      mail = await sendApprovalEmail(church, process.env.CHURCH_ADMIN_URL || null);
      if (!mail?.ok) {
        console.warn('[approve] email not sent to', church.admin_email, '·', mail?.error);
      }
    } catch (e) {
      console.warn('[approve] email threw:', e.message);
      mail = { ok: false, error: e.message, error_code: 'threw' };
    }

    res.json({
      message: mail?.ok
        ? 'Approved and confirmation email sent.'
        : 'Approved, but confirmation email could not be sent.',
      church,
      mail: {
        ok:         !!mail?.ok,
        id:         mail?.id || null,
        from:       mail?.from || null,
        error:      mail?.error || null,
        error_code: mail?.error_code || null,
        status:     mail?.status || null,
      },
    });
  } catch (e) {
    console.error('POST /api/admin/church-applications/:id/approve:', e.code, e.message);
    res.status(500).json({ error: 'Approve failed.' });
  }
});

router.post('/api/admin/church-applications/:id/reject', adminAuth, async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').trim() || null;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(`
      UPDATE churches
         SET approval_status = 'rejected',
             rejected_reason = $2,
             rejected_at     = NOW(),
             approved_at     = NULL
       WHERE id = $1
       RETURNING id, name, admin_email, contact_name, approval_status, rejected_reason, rejected_at
    `, [id, reason]);
    if (!r.rows.length) return res.status(404).json({ error: 'Application not found.' });
    const church = r.rows[0];

    let mail;
    try {
      mail = await sendRejectionEmail(church, reason);
      if (!mail?.ok) {
        console.warn('[reject] email not sent to', church.admin_email, '·', mail?.error);
      }
    } catch (e) {
      console.warn('[reject] email threw:', e.message);
      mail = { ok: false, error: e.message, error_code: 'threw' };
    }

    res.json({
      message: mail?.ok
        ? 'Rejected and notification email sent.'
        : 'Rejected, but notification email could not be sent.',
      church,
      mail: {
        ok:         !!mail?.ok,
        id:         mail?.id || null,
        from:       mail?.from || null,
        error:      mail?.error || null,
        error_code: mail?.error_code || null,
        status:     mail?.status || null,
      },
    });
  } catch (e) {
    console.error('POST /api/admin/church-applications/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Reject failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIL HEALTH CHECK
// Two endpoints: GET probes Resend config without sending; POST sends a test.
// Both are admin-only and never throw — failures come back as 200 { ok:false }.
// ─────────────────────────────────────────────────────────────────────────────

const probeResendDomains = async (apiKey) => {
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  try {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && /restricted/i.test(data?.name || data?.message || '')) {
      return { ok: true, restricted: true, domains: [], note: 'API key is send-only — cannot list domains.' };
    }
    if (!r.ok) return { ok: false, error: data?.message || `HTTP ${r.status}` };
    const domains = (data?.data || data || []).map((d) => ({
      name:   d.name,
      status: d.status,
      region: d.region,
    }));
    return { ok: true, domains };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

router.get('/api/admin/mail-test', adminAuth, async (req, res) => {
  const apiKey  = process.env.RESEND_API_KEY || '';
  const from    = process.env.MAIL_FROM || 'Gospelar Sunday School <noreply@gospelar.com>';
  const fromAddr = (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
  const sandbox = /resend\.dev>?$|<onboarding@resend\.dev>/i.test(from) || fromAddr.endsWith('@resend.dev');

  const domainStatus = await probeResendDomains(apiKey);
  const fromDomain   = fromAddr.split('@')[1] || '';
  const matchingDomain = (domainStatus.domains || []).find((d) => d.name === fromDomain);

  const hints = [];
  if (!apiKey) hints.push('Set RESEND_API_KEY in backend/.env and restart the server.');
  if (sandbox) hints.push('MAIL_FROM is using the Resend sandbox sender — emails only deliver to the Resend account owner. Verify your domain and switch MAIL_FROM.');
  if (apiKey && !sandbox && matchingDomain && matchingDomain.status !== 'verified') {
    hints.push(`The "${fromDomain}" domain is "${matchingDomain.status}" on Resend — finish DNS verification before going live.`);
  }
  if (apiKey && !sandbox && !matchingDomain && !domainStatus.restricted) {
    hints.push(`No matching domain "${fromDomain}" on this Resend account. Add and verify it.`);
  }

  const ready =
    !!apiKey
    && !sandbox
    && (domainStatus.restricted || !!(matchingDomain && matchingDomain.status === 'verified'));

  res.json({
    ok:               true,
    resend_configured: !!apiKey,
    api_key_prefix:    apiKey ? `${apiKey.slice(0, 3)}…${apiKey.length} chars` : null,
    mail_from:         from,
    from_address:      fromAddr,
    from_domain:       fromDomain,
    sandbox,
    domain_status:     domainStatus,
    ready,
    hints,
  });
});

router.post('/api/admin/mail-test', adminAuth, async (req, res) => {
  const to      = String(req.body?.to || '').trim();
  const subject = String(req.body?.subject || 'Gospelar mail health check').trim();
  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, error: 'Invalid recipient email.' });
  }
  const stampedSubject = subject + ' · ' + new Date().toISOString();
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:520px;margin:auto">
      <h2 style="margin:0 0 12px;color:#1A56DB">✓ Gospelar mail health check</h2>
      <p style="margin:0 0 10px;color:#0F172A;line-height:1.5">
        If you're reading this, the Resend pipeline from <code>${process.env.MAIL_FROM || 'default sender'}</code>
        is delivering correctly to <strong>${to}</strong>.
      </p>
      <p style="margin:0;color:#64748B;font-size:12.5px;line-height:1.5">
        Sent at ${new Date().toLocaleString('en-NG')} from the admin dashboard mail-test endpoint.
      </p>
    </div>
  `;
  const result = await sendMail({ to, subject: stampedSubject, html });
  res.json({
    ok:        result.ok,
    id:        result.id || null,
    error:     result.error || null,
    mail_from: process.env.MAIL_FROM || null,
    to,
    subject:   stampedSubject,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — REVIEW + APPROVE / REJECT TEACHER SIGNUPS
// All three endpoints use churchAuth so a church admin only sees their own
// teachers. Master ADMIN_SECRET passes too (super-admin sees everyone).
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/church-admin/teachers', churchAuth, async (req, res) => {
  const status = String(req.query.status || 'pending').toLowerCase();
  if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending|approved|rejected|all.' });
  }
  const params = [];
  const where  = [`u.role = 'teacher'`];
  if (req.church) { params.push(req.church.id); where.push(`u.church_id = $${params.length}`); }
  if (status !== 'all') {
    params.push(status);
    where.push(`COALESCE(u.approval_status, 'approved') = $${params.length}`);
  }
  try {
    const r = await db.query(`
      SELECT
        u.id, u.email, u.full_name, u.created_at,
        COALESCE(u.approval_status, 'approved') AS approval_status,
        u.approved_at, u.rejected_at, u.rejected_reason,
        COALESCE(up.display_name, u.full_name)  AS display_name,
        COALESCE(up.avatar_emoji, '👤')         AS avatar_emoji,
        up.church, up.location
      FROM users u
      LEFT JOIN user_profiles up ON up.email = u.email
      WHERE ${where.join(' AND ')}
      ORDER BY u.created_at DESC
    `, params);
    res.json({ status, count: r.rows.length, teachers: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/teachers:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load teachers.' });
  }
});

router.post('/api/church-admin/teachers/:id/approve', churchAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const params = [id];
  let scope = '';
  if (req.church) { params.push(req.church.id); scope = ` AND church_id = $${params.length}`; }
  try {
    const r = await db.query(`
      UPDATE users
         SET approval_status = 'approved',
             approved_at     = NOW(),
             approved_by_email = $${params.length + 1},
             rejected_reason = NULL,
             rejected_at     = NULL
       WHERE id = $1 AND role = 'teacher'${scope}
       RETURNING id, email, full_name, role, approval_status, approved_at
    `, [...params, req.church?.admin_email || null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Teacher not found in your church.' });
    if (req.church) {
      logActivity({
        church_id:   req.church.id,
        branch_id:   req.activeBranchId,
        actor_email: req.staff?.email,
        actor_name:  req.staff?.name,
        action:      'teacher.approved',
        entity_type: 'teacher',
        entity_id:   r.rows[0].id,
        summary:     `Approved teacher ${r.rows[0].full_name || r.rows[0].email}`,
      });
    }
    res.json({ message: 'Approved.', teacher: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/teachers/:id/approve:', e.code, e.message);
    res.status(500).json({ error: 'Approve failed.' });
  }
});

router.post('/api/church-admin/teachers/:id/reject', churchAuth, async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').trim() || null;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const params = [id, reason];
  let scope = '';
  if (req.church) { params.push(req.church.id); scope = ` AND church_id = $${params.length}`; }
  try {
    const r = await db.query(`
      UPDATE users
         SET approval_status = 'rejected',
             rejected_reason = $2,
             rejected_at     = NOW(),
             approved_at     = NULL
       WHERE id = $1 AND role = 'teacher'${scope}
       RETURNING id, email, full_name, role, approval_status, rejected_reason, rejected_at
    `, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Teacher not found in your church.' });
    if (req.church) {
      logActivity({
        church_id:   req.church.id,
        branch_id:   req.activeBranchId,
        actor_email: req.staff?.email,
        actor_name:  req.staff?.name,
        action:      'teacher.rejected',
        entity_type: 'teacher',
        entity_id:   r.rows[0].id,
        summary:     `Rejected teacher ${r.rows[0].full_name || r.rows[0].email}${reason ? ` — ${reason}` : ''}`,
      });
    }
    res.json({ message: 'Rejected.', teacher: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/teachers/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Reject failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — DASHBOARD BOOTSTRAP + BRANCHES + STAFF + ACTIVITY + KPIs
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/church-admin/me', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const br = await db.query(
      `SELECT id, name, location, is_headquarters, created_at
         FROM branches
        WHERE church_id = $1
        ORDER BY is_headquarters DESC, name ASC`,
      [req.church.id],
    );
    const { admin_token, ...churchSafe } = req.church;
    res.json({
      church:         churchSafe,
      staff:          req.staff,
      branches:       br.rows,
      activeBranchId: req.activeBranchId,
    });
  } catch (e) {
    console.error('GET /api/church-admin/me:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// ── Branches ────────────────────────────────────────────────────────────────
router.get('/api/church-admin/branches', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const r = await db.query(
      `SELECT b.id, b.name, b.location, b.is_headquarters, b.created_at,
              (SELECT COUNT(*)::int FROM users         u WHERE u.branch_id = b.id) AS member_count,
              (SELECT COUNT(*)::int FROM classes       c WHERE c.branch_id = b.id) AS class_count,
              (SELECT COUNT(*)::int FROM activity_log  a WHERE a.branch_id = b.id
                 AND a.created_at > NOW() - INTERVAL '30 days')                    AS recent_activity
         FROM branches b
        WHERE b.church_id = $1
        ORDER BY b.is_headquarters DESC, b.name ASC`,
      [req.church.id],
    );
    res.json({ branches: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/branches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load branches.' });
  }
});

router.post('/api/church-admin/branches', churchAuth, requirePerm('branches', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const name = String(req.body?.name || '').trim();
  const location = String(req.body?.location || '').trim() || null;
  const isHq = !!req.body?.is_headquarters;
  if (!name) return res.status(400).json({ error: 'Branch name is required.' });
  try {
    if (isHq) {
      await db.query('UPDATE branches SET is_headquarters = FALSE WHERE church_id = $1', [req.church.id]);
    }
    const r = await db.query(
      `INSERT INTO branches (church_id, name, location, is_headquarters)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, location, is_headquarters, created_at`,
      [req.church.id, name, location, isHq],
    );
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'branch.created', entity_type: 'branch', entity_id: r.rows[0].id,
      summary: `Created branch ${name}`,
    });
    res.status(201).json({ branch: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A branch with this name already exists.' });
    console.error('POST /api/church-admin/branches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create branch.' });
  }
});

router.put('/api/church-admin/branches/:id', churchAuth, requirePerm('branches', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const name = req.body?.name != null ? String(req.body.name).trim() : null;
  const location = req.body?.location != null ? (String(req.body.location).trim() || null) : null;
  const isHq = req.body?.is_headquarters;
  try {
    if (isHq === true) {
      await db.query('UPDATE branches SET is_headquarters = FALSE WHERE church_id = $1', [req.church.id]);
    }
    const r = await db.query(
      `UPDATE branches
          SET name            = COALESCE($1, name),
              location        = COALESCE($2, location),
              is_headquarters = COALESCE($3, is_headquarters)
        WHERE id = $4 AND church_id = $5
        RETURNING id, name, location, is_headquarters, created_at`,
      [name, location, typeof isHq === 'boolean' ? isHq : null, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Branch not found.' });
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'branch.updated', entity_type: 'branch', entity_id: r.rows[0].id,
      summary: `Updated branch ${r.rows[0].name}`,
    });
    res.json({ branch: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/branches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update branch.' });
  }
});

router.delete('/api/church-admin/branches/:id', churchAuth, requirePerm('branches', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const dep = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users   WHERE branch_id = $1) AS users,
         (SELECT COUNT(*)::int FROM classes WHERE branch_id = $1) AS classes`,
      [id],
    );
    const { users: uc, classes: cc } = dep.rows[0];
    if (uc > 0 || cc > 0) {
      return res.status(409).json({
        error: 'Branch has dependents.',
        members: uc,
        classes: cc,
        message: 'Reassign members and classes to another branch before deleting.',
      });
    }
    const r = await db.query(
      'DELETE FROM branches WHERE id = $1 AND church_id = $2 RETURNING id, name',
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Branch not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'branch.deleted', entity_type: 'branch', entity_id: id,
      summary: `Deleted branch ${r.rows[0].name}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/branches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete branch.' });
  }
});

// ── Staff ───────────────────────────────────────────────────────────────────
const STAFF_ROLES = ['super_admin', 'pastor', 'finance', 'worker', 'sunday_school_teacher', 'member'];

router.get('/api/church-admin/staff', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const r = await db.query(
      `SELECT s.id, s.email, s.name, s.role, s.status, s.branch_id, s.created_at,
              b.name AS branch_name
         FROM staff s
         LEFT JOIN branches b ON b.id = s.branch_id
        WHERE s.church_id = $1
        ORDER BY s.role ASC, s.name ASC`,
      [req.church.id],
    );
    res.json({ staff: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/staff:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load staff.' });
  }
});

router.post('/api/church-admin/staff', churchAuth, requirePerm('staff', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const email = String(req.body?.email || '').toLowerCase().trim();
  const name  = String(req.body?.name  || '').trim() || null;
  const role  = String(req.body?.role  || 'worker');
  const branch_id = req.body?.branch_id ? parseInt(req.body.branch_id, 10) : null;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (branch_id != null && !Number.isFinite(branch_id)) return res.status(400).json({ error: 'Invalid branch_id.' });
  try {
    if (branch_id) {
      const b = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branch_id, req.church.id]);
      if (!b.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
    }
    const r = await db.query(
      `INSERT INTO staff (church_id, branch_id, email, name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'invited')
       RETURNING id, email, name, role, status, branch_id, created_at`,
      [req.church.id, branch_id, email, name, role],
    );
    logActivity({
      church_id: req.church.id, branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'staff.invited', entity_type: 'staff', entity_id: r.rows[0].id,
      summary: `Invited ${name || email} as ${role}`,
    });
    res.status(201).json({ staff: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Someone with this email is already on the roster.' });
    console.error('POST /api/church-admin/staff:', e.code, e.message);
    res.status(500).json({ error: 'Failed to invite staff.' });
  }
});

router.put('/api/church-admin/staff/:id', churchAuth, requirePerm('staff', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const role   = req.body?.role   != null ? String(req.body.role)   : null;
  const status = req.body?.status != null ? String(req.body.status) : null;
  const name   = req.body?.name   != null ? String(req.body.name).trim() || null : null;
  const branch_id = req.body?.branch_id !== undefined
    ? (req.body.branch_id == null ? null : parseInt(req.body.branch_id, 10))
    : undefined;
  if (role && !STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (status && !['active', 'invited', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    if (branch_id) {
      const b = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branch_id, req.church.id]);
      if (!b.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
    }
    const r = await db.query(
      `UPDATE staff
          SET role      = COALESCE($1, role),
              status    = COALESCE($2, status),
              name      = COALESCE($3, name),
              branch_id = CASE WHEN $5::int = 1 THEN $4::int ELSE branch_id END
        WHERE id = $6 AND church_id = $7
        RETURNING id, email, name, role, status, branch_id, created_at`,
      [role, status, name, branch_id ?? null, branch_id !== undefined ? 1 : 0, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Staff not found.' });
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'staff.updated', entity_type: 'staff', entity_id: r.rows[0].id,
      summary: `Updated ${r.rows[0].name || r.rows[0].email} (${r.rows[0].role})`,
    });
    res.json({ staff: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/staff/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update staff.' });
  }
});

router.delete('/api/church-admin/staff/:id', churchAuth, requirePerm('staff', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    // Don't allow removing the church's own admin_email row — that would lock
    // the church out of its own dashboard.
    const r = await db.query(
      `DELETE FROM staff
        WHERE id = $1
          AND church_id = $2
          AND LOWER(email) <> LOWER((SELECT admin_email FROM churches WHERE id = $2))
        RETURNING id, email, name`,
      [id, req.church.id],
    );
    if (!r.rows.length) {
      return res.status(409).json({ error: 'Cannot remove the church admin.' });
    }
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'staff.removed', entity_type: 'staff', entity_id: id,
      summary: `Removed ${r.rows[0].name || r.rows[0].email}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/staff/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to remove staff.' });
  }
});

// ── Activity feed ──────────────────────────────────────────────────────────
// Cursor pagination: ?since_id=N returns rows with id > N (for "new since
// last poll"). Without since_id, returns the most recent `limit` rows.
router.get('/api/church-admin/activity', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const sinceId = req.query.since_id ? parseInt(req.query.since_id, 10) : null;
  const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
  try {
    const params = [req.church.id];
    let where = 'WHERE church_id = $1';
    if (req.activeBranchId) {
      params.push(req.activeBranchId);
      where += ` AND branch_id = $${params.length}`;
    }
    if (entityType) {
      params.push(entityType);
      where += ` AND entity_type = $${params.length}`;
    }
    let orderClause;
    if (Number.isFinite(sinceId)) {
      params.push(sinceId);
      where += ` AND id > $${params.length}`;
      orderClause = 'ORDER BY id ASC';
    } else {
      orderClause = 'ORDER BY id DESC';
    }
    params.push(limit);
    const r = await db.query(
      `SELECT id, branch_id, actor_email, actor_name, action, entity_type, entity_id,
              summary, metadata, created_at
         FROM activity_log
         ${where}
         ${orderClause}
         LIMIT $${params.length}`,
      params,
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('GET /api/church-admin/activity:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load activity.' });
  }
});

// ── Admin summary KPIs — Members / Attendance / Engagement / Donations ─────
router.get('/api/church-admin/insights/admin-summary', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const cid = req.church.id;
  const bid = req.activeBranchId;
  const branchFilter = bid ? ' AND branch_id = $2' : '';
  const params = bid ? [cid, bid] : [cid];
  try {
    const [members, attendance, engagement] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM members
             WHERE church_id = $1${branchFilter}
               AND status IN ('member','first_timer')) AS members_total,
           (SELECT COUNT(*)::int FROM members
             WHERE church_id = $1${branchFilter}
               AND status IN ('member','first_timer')
               AND created_at >= date_trunc('month', NOW())) AS members_this_month,
           (SELECT COUNT(*)::int FROM members
             WHERE church_id = $1${branchFilter}
               AND status IN ('member','first_timer')
               AND created_at >= date_trunc('month', NOW() - INTERVAL '1 month')
               AND created_at <  date_trunc('month', NOW())) AS members_last_month`,
        params,
      ),
      db.query(
        `SELECT
           (SELECT COUNT(DISTINCT (class_id, lesson_number, student_email))::int FROM teacher_marks
             WHERE church_id = $1${branchFilter}
               AND awarded_at >= NOW() - INTERVAL '7 days')   AS attendance_this_week,
           (SELECT COUNT(DISTINCT (class_id, lesson_number, student_email))::int FROM teacher_marks
             WHERE church_id = $1${branchFilter}
               AND awarded_at >= NOW() - INTERVAL '14 days'
               AND awarded_at <  NOW() - INTERVAL '7 days')  AS attendance_last_week`,
        params,
      ),
      db.query(
        `SELECT
           (SELECT COUNT(*)::int
              FROM user_scores us
              JOIN class_members cm ON cm.student_email = us.email
              JOIN classes c        ON c.id = cm.class_id
             WHERE c.church_id = $1${bid ? ' AND c.branch_id = $2' : ''}
               AND us.completed_at >= NOW() - INTERVAL '7 days') AS lessons_7d,
           (SELECT COUNT(*)::int
              FROM user_scores us
              JOIN class_members cm ON cm.student_email = us.email
              JOIN classes c        ON c.id = cm.class_id
             WHERE c.church_id = $1${bid ? ' AND c.branch_id = $2' : ''}
               AND us.completed_at >= NOW() - INTERVAL '14 days'
               AND us.completed_at <  NOW() - INTERVAL '7 days') AS lessons_prev_7d`,
        params,
      ),
    ]);

    res.json({
      members: {
        total:      members.rows[0].members_total,
        this_month: members.rows[0].members_this_month,
        last_month: members.rows[0].members_last_month,
      },
      attendance: {
        this_week: attendance.rows[0].attendance_this_week,
        last_week: attendance.rows[0].attendance_last_week,
      },
      engagement: {
        lessons_7d:      engagement.rows[0].lessons_7d,
        lessons_prev_7d: engagement.rows[0].lessons_prev_7d,
      },
      donations: { last_30d: 0, prev_30d: 0, note: 'finance tables not yet provisioned' },
    });
  } catch (e) {
    console.error('GET /api/church-admin/insights/admin-summary:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load summary.' });
  }
});

router.get('/api/church-admin/insights/member-growth', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const days = Math.min(parseInt(req.query.days, 10) || 180, 730);
  const cid = req.church.id;
  const bid = req.activeBranchId;
  const branchFilter = bid ? ' AND branch_id = $3' : '';
  const params = bid ? [String(days), cid, bid] : [String(days), cid];
  try {
    const daily = await db.query(
      `SELECT date_trunc('day', created_at)::date AS day,
              COUNT(*)::int AS joined
         FROM members
        WHERE church_id = $2${branchFilter}
          AND status IN ('member','first_timer')
          AND created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY day
        ORDER BY day ASC`,
      params,
    );
    const startTotal = await db.query(
      `SELECT COUNT(*)::int AS total
         FROM members
        WHERE church_id = $2${branchFilter}
          AND status IN ('member','first_timer')
          AND created_at <  NOW() - ($1 || ' days')::interval`,
      params,
    );
    let running = startTotal.rows[0].total;
    const series = daily.rows.map((row) => {
      running += row.joined;
      return { day: row.day, joined: row.joined, cumulative: running };
    });
    res.json({ windowDays: days, startTotal: startTotal.rows[0].total, series });
  } catch (e) {
    console.error('GET /api/church-admin/insights/member-growth:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load member growth.' });
  }
});

module.exports = router;
