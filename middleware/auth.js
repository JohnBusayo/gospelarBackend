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

module.exports = {
  adminAuth, churchAuth, requirePerm,
  churchScope, branchScope,
  ROLE_PERMS,
};
