// routes/learning.js
// Sunday School oversight from the church-admin lens: read-only class +
// student rollups, certificate issue/list/revoke, and the marks pipeline
// (collated view of every teacher_marks row written by the teacher app).
// All queries scope through `classes.church_id` so cross-church leakage is
// impossible.

const express = require('express');
const db = require('../db');
const { churchAuth } = require('../middleware/auth');
const { logActivity } = require('../middleware/activity');
const { isValidEmail, makeCertNo } = require('../utils/helpers');

const router = express.Router();

const CERTIFICATE_TYPES = ['completion', 'excellence', 'attendance', 'memorization', 'custom'];

router.get('/api/church-admin/learning/classes', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const params = [req.church.id];
  let where = 'WHERE c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND c.branch_id = $${params.length}`;
  }
  try {
    const r = await db.query(
      `SELECT c.id, c.name, c.category, c.invite_code, c.created_at,
              c.teacher_email,
              u.full_name AS teacher_name,
              u.approval_status AS teacher_status,
              (SELECT COUNT(*)::int FROM class_members cm WHERE cm.class_id = c.id)
                AS enrollment,
              (SELECT COUNT(DISTINCT (tm.lesson_number, tm.student_email))::int
                 FROM teacher_marks tm WHERE tm.class_id = c.id) AS attendance_count,
              (SELECT COUNT(DISTINCT tm.lesson_number)::int
                 FROM teacher_marks tm WHERE tm.class_id = c.id) AS lessons_taught,
              (SELECT MAX(tm.awarded_at) FROM teacher_marks tm WHERE tm.class_id = c.id)
                AS last_active_at
         FROM classes c
         LEFT JOIN users u ON LOWER(u.email) = LOWER(c.teacher_email)
         ${where}
         ORDER BY c.created_at DESC`,
      params,
    );
    res.json({ classes: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/learning/classes:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load classes.' });
  }
});

// Roster for a single class. Returns the students enrolled in the class
// (via class_members) plus per-student engagement stats so the church-admin
// "click a class to see students" panel can show useful context inline
// without a second round-trip. Church-scoped — a class that doesn't belong
// to req.church.id returns 404 even if it exists in another tenant.
router.get('/api/church-admin/learning/classes/:classId/students', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const classId = parseInt(req.params.classId, 10);
  if (!Number.isFinite(classId)) return res.status(400).json({ error: 'Invalid class id.' });
  try {
    // Verify the class belongs to this church (and to the active branch when
    // one is selected) before exposing the roster. Returning the class row
    // alongside the students lets the client render a header without a
    // separate fetch.
    const params = [classId, req.church.id];
    let where = 'c.id = $1 AND c.church_id = $2';
    if (req.activeBranchId) {
      params.push(req.activeBranchId);
      where += ` AND c.branch_id = $${params.length}`;
    }
    const cls = await db.query(
      `SELECT c.id, c.name, c.category, c.invite_code, c.teacher_email,
              c.branch_id, c.created_at,
              u.full_name AS teacher_name
         FROM classes c
         LEFT JOIN users u ON LOWER(u.email) = LOWER(c.teacher_email)
        WHERE ${where}`,
      params,
    );
    if (!cls.rows.length) return res.status(404).json({ error: 'Class not found.' });

    // Per-student engagement stats joined in a single query. The subqueries
    // for attendance / marks / points are correlated to the class so we
    // count only this class's activity (not the student's total across all
    // classes — that's what /learning/students is for).
    //
    // Two name sources matter: user_profiles.display_name is set by the
    // mobile app *and* by the teacher when they add a student by name only
    // (those students get a synthetic local_*@local.gofamint email — see
    // routes/teacher.js). users.full_name is the auth-table fallback for
    // app users with a real email. Coalesce display → full_name → email,
    // and treat synthetic addresses as "no email" so we don't render the
    // pseudo-email as a name when nothing else is on file.
    const r = await db.query(
      `SELECT cm.student_email                                     AS email,
              COALESCE(
                NULLIF(TRIM(up.display_name), ''),
                NULLIF(TRIM(u.full_name), ''),
                CASE WHEN cm.student_email LIKE '%@local.gofamint'
                     THEN 'Unnamed student'
                     ELSE cm.student_email
                END
              )                                                    AS name,
              cm.joined_at,
              u.approval_status                                    AS status,
              up.avatar_emoji,
              (SELECT COUNT(*)::int FROM attendance a
                 WHERE a.class_id = cm.class_id
                   AND LOWER(a.student_email) = LOWER(cm.student_email)
                   AND a.present = TRUE)                           AS attendance_count,
              (SELECT COUNT(*)::int FROM teacher_marks tm
                 WHERE tm.class_id = cm.class_id
                   AND LOWER(tm.student_email) = LOWER(cm.student_email)) AS marks_count,
              (SELECT COALESCE(SUM(tm.points), 0)::int FROM teacher_marks tm
                 WHERE tm.class_id = cm.class_id
                   AND LOWER(tm.student_email) = LOWER(cm.student_email)) AS total_points,
              GREATEST(
                COALESCE((SELECT MAX(a.marked_at) FROM attendance a
                            WHERE a.class_id = cm.class_id
                              AND LOWER(a.student_email) = LOWER(cm.student_email)), '-infinity'::timestamptz),
                COALESCE((SELECT MAX(tm.awarded_at) FROM teacher_marks tm
                            WHERE tm.class_id = cm.class_id
                              AND LOWER(tm.student_email) = LOWER(cm.student_email)), '-infinity'::timestamptz)
              )                                                    AS last_active_at
         FROM class_members cm
         LEFT JOIN user_profiles up ON LOWER(up.email) = LOWER(cm.student_email)
         LEFT JOIN users         u  ON LOWER(u.email)  = LOWER(cm.student_email)
        WHERE cm.class_id = $1
        ORDER BY name ASC`,
      [classId],
    );
    // Convert the sentinel '-infinity' we used for the GREATEST() fallback
    // back to null so the client can render "Never" without a date check.
    const students = r.rows.map((s) => ({
      ...s,
      last_active_at:
        !s.last_active_at || new Date(s.last_active_at).getFullYear() < 1900
          ? null
          : s.last_active_at,
    }));
    res.json({ class: cls.rows[0], students, count: students.length });
  } catch (e) {
    console.error('GET /api/church-admin/learning/classes/:classId/students:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load class roster.' });
  }
});

router.get('/api/church-admin/learning/students', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const term  = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
  const params = [req.church.id];
  if (req.activeBranchId) params.push(req.activeBranchId);
  const branchClause = req.activeBranchId ? ` AND c.branch_id = $2` : '';
  if (term) params.push(term);
  const termIdx = params.length;
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT DISTINCT cm.student_email,
              COALESCE(u.full_name, cm.student_email)              AS student_name,
              COUNT(DISTINCT cm.class_id)                          AS classes_count,
              (SELECT COUNT(*)::int FROM user_scores us
                 WHERE LOWER(us.email) = LOWER(cm.student_email))  AS lessons_completed,
              (SELECT COALESCE(SUM(us.score), 0)::int FROM user_scores us
                 WHERE LOWER(us.email) = LOWER(cm.student_email))  AS total_score,
              (SELECT COUNT(*)::int FROM teacher_marks tm
                 WHERE tm.church_id = $1
                   AND LOWER(tm.student_email) = LOWER(cm.student_email))
                                                                   AS marks_received,
              (SELECT MAX(us.completed_at) FROM user_scores us
                 WHERE LOWER(us.email) = LOWER(cm.student_email))  AS last_active
         FROM class_members cm
         JOIN classes c ON c.id = cm.class_id
         LEFT JOIN users u ON LOWER(u.email) = LOWER(cm.student_email)
        WHERE c.church_id = $1${branchClause}
          ${term ? `AND (LOWER(cm.student_email) LIKE $${termIdx} OR LOWER(COALESCE(u.full_name, '')) LIKE $${termIdx})` : ''}
        GROUP BY cm.student_email, u.full_name
        ORDER BY lessons_completed DESC NULLS LAST, student_name ASC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ students: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/learning/students:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load students.' });
  }
});

// ── Certificates ───────────────────────────────────────────────────────────
router.get('/api/church-admin/certificates', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const type        = req.query.type ? String(req.query.type) : null;
  const q           = req.query.q    ? String(req.query.q).toLowerCase() : null;
  const includeRevoked = String(req.query.include_revoked || 'false') === 'true';
  const params = [req.church.id];
  let where = 'WHERE church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND branch_id = $${params.length}`;
  }
  if (type) {
    if (!CERTIFICATE_TYPES.includes(type))
      return res.status(400).json({ error: 'Invalid certificate type.' });
    params.push(type);
    where += ` AND type = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (LOWER(student_name) LIKE $${params.length} OR LOWER(student_email) LIKE $${params.length} OR LOWER(title) LIKE $${params.length})`;
  }
  if (!includeRevoked) where += ` AND revoked_at IS NULL`;
  try {
    const r = await db.query(
      `SELECT id, student_email, student_name, type, title, body, context,
              certificate_no, awarded_by, awarded_at, revoked_at, branch_id
         FROM certificates
         ${where}
         ORDER BY awarded_at DESC
         LIMIT 500`,
      params,
    );
    res.json({ certificates: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/certificates:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load certificates.' });
  }
});

router.get('/api/church-admin/certificates/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `SELECT c.*, ch.name AS church_name, b.name AS branch_name
         FROM certificates c
         JOIN churches ch ON ch.id = c.church_id
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE c.id = $1 AND c.church_id = $2`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found.' });
    res.json({ certificate: r.rows[0] });
  } catch (e) {
    console.error('GET /api/church-admin/certificates/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load certificate.' });
  }
});

router.post('/api/church-admin/certificates', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const {
    student_email, student_name, type, title, body, context, awarded_at,
  } = req.body || {};
  if (!student_email || !isValidEmail(student_email))
    return res.status(400).json({ error: 'A valid student_email is required.' });
  if (!student_name?.trim())
    return res.status(400).json({ error: 'student_name is required.' });
  if (!type || !CERTIFICATE_TYPES.includes(type))
    return res.status(400).json({ error: `type must be one of ${CERTIFICATE_TYPES.join(', ')}.` });
  if (!title?.trim())
    return res.status(400).json({ error: 'title is required.' });
  try {
    const r = await db.query(
      `INSERT INTO certificates
         (church_id, branch_id, student_email, student_name, type, title, body,
          context, certificate_no, awarded_by, awarded_at)
       VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, $8::jsonb,
               $9, $10, COALESCE($11::timestamptz, NOW()))
       RETURNING *`,
      [
        req.church.id, req.activeBranchId, student_email, student_name.trim(),
        type, title.trim(), body || null,
        context ? JSON.stringify(context) : null,
        makeCertNo(),
        req.staff?.email || null, awarded_at || null,
      ],
    );
    logActivity({
      church_id: req.church.id, branch_id: req.activeBranchId,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'certificate.issued', entity_type: 'certificate', entity_id: r.rows[0].id,
      summary: `Issued ${type} certificate to ${student_name.trim()}`,
    });
    res.status(201).json({ certificate: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/certificates:', e.code, e.message);
    res.status(500).json({ error: 'Failed to issue certificate.' });
  }
});

// Soft-delete by setting revoked_at — preserves audit history.
router.delete('/api/church-admin/certificates/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `UPDATE certificates SET revoked_at = NOW()
        WHERE id = $1 AND church_id = $2 AND revoked_at IS NULL
        RETURNING id, student_name, type, branch_id`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found or already revoked.' });
    const c = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: c.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'certificate.revoked', entity_type: 'certificate', entity_id: id,
      summary: `Revoked ${c.type} certificate for ${c.student_name}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/certificates/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to revoke certificate.' });
  }
});

// ── Marks ──────────────────────────────────────────────────────────────────
router.get('/api/church-admin/marks', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const sinceId = req.query.since_id ? parseInt(req.query.since_id, 10) : null;
  const params = [req.church.id];
  let where = 'WHERE c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND c.branch_id = $${params.length}`;
  }
  if (req.query.class_id) {
    const cid = parseInt(req.query.class_id, 10);
    if (Number.isFinite(cid)) {
      params.push(cid);
      where += ` AND tm.class_id = $${params.length}`;
    }
  }
  if (req.query.lesson) {
    const ln = parseInt(req.query.lesson, 10);
    if (Number.isFinite(ln)) {
      params.push(ln);
      where += ` AND tm.lesson_number = $${params.length}`;
    }
  }
  if (req.query.student_email) {
    params.push(String(req.query.student_email).toLowerCase());
    where += ` AND LOWER(tm.student_email) = $${params.length}`;
  }
  if (req.query.mark_type) {
    params.push(String(req.query.mark_type));
    where += ` AND tm.mark_type = $${params.length}`;
  }
  if (req.query.awarded_by) {
    params.push(String(req.query.awarded_by).toLowerCase());
    where += ` AND LOWER(tm.awarded_by) = $${params.length}`;
  }
  let orderClause;
  if (Number.isFinite(sinceId)) {
    params.push(sinceId);
    where += ` AND tm.id > $${params.length}`;
    orderClause = 'ORDER BY tm.id ASC';
  } else {
    orderClause = 'ORDER BY tm.awarded_at DESC, tm.id DESC';
  }
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT tm.id, tm.class_id, tm.lesson_number, tm.student_email,
              tm.mark_type, tm.points, tm.note, tm.awarded_by, tm.awarded_at,
              c.name AS class_name, c.category AS class_category, c.invite_code,
              c.branch_id, b.name AS branch_name,
              COALESCE(u_student.full_name, tm.student_email) AS student_name,
              COALESCE(u_teacher.full_name, tm.awarded_by)    AS teacher_name
         FROM teacher_marks tm
         JOIN classes c           ON c.id = tm.class_id
         LEFT JOIN branches b     ON b.id = c.branch_id
         LEFT JOIN users u_student ON LOWER(u_student.email) = LOWER(tm.student_email)
         LEFT JOIN users u_teacher ON LOWER(u_teacher.email) = LOWER(tm.awarded_by)
         ${where}
         ${orderClause}
         LIMIT $${params.length}`,
      params,
    );
    res.json({ marks: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('GET /api/church-admin/marks:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load marks.' });
  }
});

router.get('/api/church-admin/marks/summary', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const params = [req.church.id];
  let cFilter = 'c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    cFilter += ` AND c.branch_id = $${params.length}`;
  }
  try {
    const [windowed, byType, topStudent, topClass, topTeacher, daily] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '7 days')   AS marks_7d,
           (SELECT COUNT(*)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '14 days'
                                AND tm.awarded_at <  NOW() - INTERVAL '7 days') AS marks_prev_7d,
           (SELECT COALESCE(SUM(tm.points), 0)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '7 days')  AS points_7d,
           (SELECT COALESCE(SUM(tm.points), 0)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '14 days'
                                AND tm.awarded_at <  NOW() - INTERVAL '7 days') AS points_prev_7d,
           (SELECT COUNT(DISTINCT tm.awarded_by)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days') AS active_teachers_30d`,
        params,
      ),
      db.query(
        `SELECT tm.mark_type AS type,
                COUNT(*)::int AS count,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY tm.mark_type
          ORDER BY count DESC`,
        params,
      ),
      db.query(
        `SELECT tm.student_email AS email,
                COALESCE(u.full_name, tm.student_email) AS name,
                COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm
           JOIN classes c ON c.id = tm.class_id
           LEFT JOIN users u ON LOWER(u.email) = LOWER(tm.student_email)
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY tm.student_email, u.full_name
          ORDER BY points DESC, marks DESC
          LIMIT 1`,
        params,
      ),
      db.query(
        `SELECT c.id, c.name, COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY c.id, c.name
          ORDER BY marks DESC
          LIMIT 1`,
        params,
      ),
      db.query(
        `SELECT tm.awarded_by AS email,
                COALESCE(u.full_name, tm.awarded_by) AS name,
                COUNT(*)::int AS marks
           FROM teacher_marks tm
           JOIN classes c ON c.id = tm.class_id
           LEFT JOIN users u ON LOWER(u.email) = LOWER(tm.awarded_by)
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY tm.awarded_by, u.full_name
          ORDER BY marks DESC
          LIMIT 1`,
        params,
      ),
      db.query(
        `SELECT date_trunc('day', tm.awarded_at)::date AS day,
                COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY day
          ORDER BY day ASC`,
        params,
      ),
    ]);
    res.json({
      windowed:   windowed.rows[0],
      byType:     byType.rows,
      topStudent: topStudent.rows[0] || null,
      topClass:   topClass.rows[0]   || null,
      topTeacher: topTeacher.rows[0] || null,
      daily:      daily.rows,
    });
  } catch (e) {
    console.error('GET /api/church-admin/marks/summary:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load summary.' });
  }
});

router.get('/api/church-admin/marks/by-class/:classId', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const classId = parseInt(req.params.classId, 10);
  if (!Number.isFinite(classId)) return res.status(400).json({ error: 'Invalid class id.' });
  try {
    const cls = await db.query(
      `SELECT c.id, c.name, c.category, c.invite_code, c.teacher_email,
              u.full_name AS teacher_name
         FROM classes c
         LEFT JOIN users u ON LOWER(u.email) = LOWER(c.teacher_email)
        WHERE c.id = $1 AND c.church_id = $2`,
      [classId, req.church.id],
    );
    if (!cls.rows.length) return res.status(404).json({ error: 'Class not found.' });

    const [lessonsR, membersR, marksR] = await Promise.all([
      db.query(
        `SELECT lesson_number,
                COUNT(*)::int AS marks_count,
                COALESCE(SUM(points), 0)::int AS total_points,
                MAX(awarded_at) AS last_awarded_at
           FROM teacher_marks
          WHERE class_id = $1
          GROUP BY lesson_number
          ORDER BY lesson_number ASC`,
        [classId],
      ),
      db.query(
        `SELECT cm.student_email AS email,
                COALESCE(u.full_name, cm.student_email) AS name,
                cm.joined_at
           FROM class_members cm
           LEFT JOIN users u ON LOWER(u.email) = LOWER(cm.student_email)
          WHERE cm.class_id = $1
          ORDER BY name ASC`,
        [classId],
      ),
      db.query(
        `SELECT student_email, lesson_number, mark_type,
                COUNT(*)::int AS marks,
                COALESCE(SUM(points), 0)::int AS points
           FROM teacher_marks
          WHERE class_id = $1
          GROUP BY student_email, lesson_number, mark_type
          ORDER BY lesson_number, student_email`,
        [classId],
      ),
    ]);

    // Pivot into the students × lessons matrix shape the client expects.
    const studentMap = new Map();
    for (const m of membersR.rows) {
      studentMap.set(m.email.toLowerCase(), {
        email: m.email, name: m.name, joined_at: m.joined_at,
        lessons: {}, totals: { marks: 0, points: 0 },
      });
    }
    // Some marks may belong to students who left the class — include them
    // anyway so admins see the full picture.
    for (const m of marksR.rows) {
      const key = m.student_email.toLowerCase();
      if (!studentMap.has(key)) {
        studentMap.set(key, {
          email: m.student_email, name: m.student_email,
          joined_at: null, lessons: {}, totals: { marks: 0, points: 0 },
          left_class: true,
        });
      }
      const s = studentMap.get(key);
      const l = s.lessons[m.lesson_number] || { marks: 0, points: 0, by_type: {} };
      l.marks  += m.marks;
      l.points += m.points;
      l.by_type[m.mark_type] = (l.by_type[m.mark_type] || 0) + m.points;
      s.lessons[m.lesson_number] = l;
      s.totals.marks  += m.marks;
      s.totals.points += m.points;
    }
    const students = [...studentMap.values()]
      .sort((a, b) => b.totals.points - a.totals.points);

    res.json({
      class:    cls.rows[0],
      lessons:  lessonsR.rows,
      students,
    });
  } catch (e) {
    console.error('GET /api/church-admin/marks/by-class/:classId:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load class marks.' });
  }
});

router.get('/api/church-admin/marks/by-student', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email is required.' });
  const params = [req.church.id, email];
  let cFilter = 'c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    cFilter += ` AND c.branch_id = $${params.length}`;
  }
  try {
    const [studentR, totalsR, byClassR, recentR, byTypeR] = await Promise.all([
      db.query(
        `SELECT u.email, COALESCE(u.full_name, u.email) AS name,
                u.role, u.approval_status, u.created_at
           FROM users u WHERE LOWER(u.email) = $1`,
        [email],
      ),
      db.query(
        `SELECT COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points,
                MIN(tm.awarded_at) AS first_awarded,
                MAX(tm.awarded_at) AS last_awarded
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2`,
        params,
      ),
      db.query(
        `SELECT c.id AS class_id, c.name AS class_name, c.category,
                COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points,
                COUNT(DISTINCT tm.lesson_number)::int AS lessons_covered,
                MAX(tm.awarded_at) AS last_awarded
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2
          GROUP BY c.id, c.name, c.category
          ORDER BY points DESC`,
        params,
      ),
      db.query(
        `SELECT tm.id, tm.class_id, c.name AS class_name,
                tm.lesson_number, tm.mark_type, tm.points, tm.note,
                tm.awarded_by, tm.awarded_at,
                COALESCE(u.full_name, tm.awarded_by) AS teacher_name
           FROM teacher_marks tm
           JOIN classes c ON c.id = tm.class_id
           LEFT JOIN users u ON LOWER(u.email) = LOWER(tm.awarded_by)
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2
          ORDER BY tm.awarded_at DESC
          LIMIT 50`,
        params,
      ),
      db.query(
        `SELECT tm.mark_type AS type,
                COUNT(*)::int AS count,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2
          GROUP BY tm.mark_type
          ORDER BY count DESC`,
        params,
      ),
    ]);
    res.json({
      student: studentR.rows[0] || { email, name: email, role: null },
      totals:  totalsR.rows[0],
      byClass: byClassR.rows,
      byType:  byTypeR.rows,
      recent:  recentR.rows,
    });
  } catch (e) {
    console.error('GET /api/church-admin/marks/by-student:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load student scorecard.' });
  }
});

module.exports = router;
