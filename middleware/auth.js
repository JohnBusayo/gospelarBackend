// middleware/auth.js
// Token-based auth + role-based permission middleware shared by every route
// module. Two layers:
//
//   adminAuth   — super-admin gate (x-admin-key === ADMIN_SECRET).
//   churchAuth  — per-church gate (x-church-key → churches.admin_token).
//                 Master x-admin-key also passes (super-admin sees everything).
//                 Attaches: req.church, req.staff, req.activeBranchId.
//   requirePerm — role × resource permission check (run AFTER churchAuth).
//
// Two helpers used by handlers to scope queries:
//   churchScope(req, paramIndex) → { sql, params }
//   branchScope(req, paramIndex) → { sql, params }

const db = require('../db');

// Bridges the churchdashboard approval system into the registration app's role
// model: an email that is `admin_email` of an `approval_status='approved'`
// church is treated as a registration super-admin on every authenticated
// request. Un-approving the church (or changing admin_email) revokes super-
// admin access on the very next request, since this runs live per call.
// CLI-promoted admins (users.role='admin') short-circuit the lookup.
async function effectiveRole(email, persistedRole) {
  if (persistedRole === 'admin') return 'admin';
  if (!email) return persistedRole || 'student';
  const r = await db.query(
    `SELECT 1 FROM churches
      WHERE LOWER(admin_email) = LOWER($1) AND approval_status = 'approved'
      LIMIT 1`,
    [email],
  );
  return r.rows.length ? 'admin' : (persistedRole || 'student');
}

const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  next();
};

const churchAuth = async (req, res, next) => {
  const masterKey = req.headers['x-admin-key'];
  if (masterKey && masterKey === process.env.ADMIN_SECRET) {
    req.church          = null;   // super-admin — no church filter
    req.staff           = { role: 'super_admin', email: null, name: 'Super Admin' };
    req.activeBranchId  = null;
    return next();
  }
  const churchKey = req.headers['x-church-key'];
  if (!churchKey) return res.status(401).json({ error: 'Missing x-church-key (or x-admin-key for super-admin).' });
  try {
    const r = await db.query(
      'SELECT id, name, location, admin_email, invite_code, approval_status FROM churches WHERE admin_token = $1',
      [churchKey]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'Invalid church token.' });
    if (r.rows[0].approval_status !== 'approved') {
      return res.status(403).json({
        error: 'church_not_approved',
        status: r.rows[0].approval_status,
        message: 'This church account is not approved yet. Wait for the main admin to authorize it.',
      });
    }
    req.church = r.rows[0];

    // Token-based login doesn't carry an end-user identity, so we treat the
    // admin_email owner as the current actor. Per-user login is a future pass.
    const sr = await db.query(
      `SELECT id, branch_id, email, name, role, status
         FROM staff
        WHERE church_id = $1 AND LOWER(email) = LOWER($2)
        LIMIT 1`,
      [req.church.id, req.church.admin_email],
    );
    req.staff = sr.rows[0] || {
      role: 'pastor', email: req.church.admin_email, name: null, branch_id: null,
    };

    const rawBranch = req.headers['x-branch-id'] || req.query.branch_id || '';
    if (rawBranch && String(rawBranch).toLowerCase() !== 'all') {
      const bid = parseInt(rawBranch, 10);
      if (!Number.isFinite(bid)) {
        return res.status(400).json({ error: 'Invalid branch_id.' });
      }
      const br = await db.query(
        'SELECT id FROM branches WHERE id = $1 AND church_id = $2',
        [bid, req.church.id],
      );
      if (!br.rows.length) {
        return res.status(403).json({ error: 'Branch not in your church.' });
      }
      req.activeBranchId = bid;
    } else {
      req.activeBranchId = null;
    }

    next();
  } catch (e) {
    console.error('churchAuth:', e.message);
    res.status(500).json({ error: 'Auth check failed.' });
  }
};

const churchScope = (req, paramIndex) => {
  if (!req.church) return { sql: '', params: [] };
  return { sql: ` AND church_id = $${paramIndex}`, params: [req.church.id] };
};

const branchScope = (req, paramIndex) => {
  if (!req.activeBranchId) return { sql: '', params: [] };
  return { sql: ` AND branch_id = $${paramIndex}`, params: [req.activeBranchId] };
};

const ROLE_PERMS = {
  super_admin: { branches: 'edit', staff: 'edit', activity: 'view', settings: 'edit', social: 'edit' },
  pastor:      { branches: 'edit', staff: 'edit', activity: 'view', settings: 'edit', social: 'edit' },
  finance:     { branches: 'view', staff: 'view', activity: 'view', settings: 'view', social: 'view' },
  worker:      { branches: 'view', staff: 'none', activity: 'view', settings: 'none', social: 'none' },
  sunday_school_teacher: { branches: 'view', staff: 'none', activity: 'view', settings: 'none', social: 'none' },
  member:      { branches: 'none', staff: 'none', activity: 'none', settings: 'none', social: 'none' },
};

const requirePerm = (resource, level) => (req, res, next) => {
  const role = req.staff?.role || 'member';
  const have = (ROLE_PERMS[role] || {})[resource] || 'none';
  const rank = { none: 0, view: 1, edit: 2 };
  if (rank[have] < rank[level]) {
    return res.status(403).json({ error: 'Forbidden', required: `${resource}:${level}`, have: `${resource}:${have}` });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// Session-token user auth — for the registration site's signed-in surfaces
// (POST /api/events by any authenticated user, etc.). Bearer token must match
// users.session_token. On success attaches `req.user = { id, email, role,
// full_name }`. Used alongside (not instead of) adminAuth for super-admin only
// routes, because super-admin is "logged-in user with role='admin'", not the
// shared x-admin-key.
// ─────────────────────────────────────────────────────────────────────────────
const userAuth = async (req, res, next) => {
  const hdr = String(req.headers.authorization || '');
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!bearer) return res.status(401).json({ error: 'Missing Bearer token.' });
  try {
    // Multi-device sessions: resolve the bearer token against user_sessions,
    // not users.session_token. A single user can have many rows, one per
    // signed-in device, so logging in on one device no longer evicts the
    // others. last_used_at is bumped lazily so future pruning can spot
    // idle sessions.
    const r = await db.query(
      `SELECT u.id, u.email, u.full_name, u.role
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = $1`,
      [bearer],
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid session.' });
    const u = r.rows[0];
    // Fire-and-forget heartbeat — failure here shouldn't reject the request.
    db.query('UPDATE user_sessions SET last_used_at = NOW() WHERE token = $1', [bearer])
      .catch((e) => console.warn('user_sessions heartbeat:', e.message));
    req.user = {
      id: u.id,
      email: u.email,
      full_name: u.full_name || '',
      role: await effectiveRole(u.email, u.role),
      sessionToken: bearer,
    };
    next();
  } catch (e) {
    console.error('userAuth:', e.message);
    res.status(500).json({ error: 'Auth check failed.' });
  }
};

// Wraps userAuth — only succeeds when the authenticated user has role='admin'.
// Use for routes that the registration site's super-admin-only menu items hit
// (e.g. admin event editing, churches listing).
const superAdminAuth = (req, res, next) => userAuth(req, res, (err) => {
  if (err) return next(err);
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Super-admin only.' });
  }
  next();
});

module.exports = {
  adminAuth, churchAuth, requirePerm,
  userAuth, superAdminAuth,
  churchScope, branchScope,
  ROLE_PERMS,
  effectiveRole,
};
