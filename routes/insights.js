// routes/insights.js
// Read-only analytics for church admins (and super-admin for the global view).
// Each route accepts ?days= (default 90, max 730) for the lookback window.
// All routes use churchAuth so they auto-scope to the caller's church (or
// see everything when called with the master ADMIN_SECRET).

const express = require('express');
const db = require('../db');
const { churchAuth, churchScope } = require('../middleware/auth');

const router = express.Router();

const insightsWindow = (req) => {
  const n = parseInt(req.query.days, 10);
  return Number.isFinite(n) && n > 0 && n <= 730 ? n : 90;
};

// 1. Attendance trends — proxied via teacher_marks (every awarded mark = a
//    student attendance record, since teachers only mark students who showed up).
router.get('/api/admin/insights/attendance', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  const tmScope = churchScope(req, 2);
  const cScope  = churchScope(req, 2);
  try {
    const [daily, byClass, summary] = await Promise.all([
      db.query(`
        SELECT date_trunc('day', awarded_at)::date AS day,
               COUNT(DISTINCT (class_id, lesson_number, student_email)) AS attended
          FROM teacher_marks
         WHERE awarded_at >= NOW() - ($1 || ' days')::interval${tmScope.sql}
         GROUP BY day
         ORDER BY day ASC
      `, [String(days), ...tmScope.params]),
      db.query(`
        SELECT c.id, c.name, c.category, c.invite_code,
               COUNT(DISTINCT (tm.lesson_number, tm.student_email)) AS attendance_count,
               COUNT(DISTINCT tm.lesson_number)                     AS lessons_with_attendance
          FROM classes c
          LEFT JOIN teacher_marks tm
            ON tm.class_id = c.id
           AND tm.awarded_at >= NOW() - ($1 || ' days')::interval
         WHERE 1=1${cScope.sql ? cScope.sql.replace('AND church_id', 'AND c.church_id') : ''}
         GROUP BY c.id
         ORDER BY attendance_count DESC NULLS LAST
         LIMIT 20
      `, [String(days), ...cScope.params]),
      db.query(`
        SELECT
          COUNT(DISTINCT (class_id, lesson_number, student_email)) AS total_attendances,
          COUNT(DISTINCT student_email)                            AS unique_students,
          COUNT(DISTINCT class_id)                                 AS active_classes
        FROM teacher_marks
        WHERE awarded_at >= NOW() - ($1 || ' days')::interval${tmScope.sql}
      `, [String(days), ...tmScope.params]),
    ]);
    res.json({
      windowDays: days,
      summary:    summary.rows[0],
      daily:      daily.rows,
      byClass:    byClass.rows,
    });
  } catch (e) {
    console.error('insights/attendance:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load attendance insights.' });
  }
});

// 2. Engagement stats — totals + active users + completions/signups over time.
//    Branches: church-scoped (this church only) vs super-admin (global metrics).
router.get('/api/admin/insights/engagement', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  try {
    if (req.church) {
      const cid = req.church.id;
      const [totals, completionsDaily, marksDaily, classes] = await Promise.all([
        db.query(`
          SELECT
            (SELECT COUNT(*) FROM users    WHERE church_id = $1 AND role = 'teacher') AS total_teachers,
            (SELECT COUNT(DISTINCT cm.student_email)
               FROM class_members cm JOIN classes c ON c.id = cm.class_id
              WHERE c.church_id = $1)                                                 AS enrolled_students,
            (SELECT COUNT(*)
               FROM user_scores us
               JOIN class_members cm ON cm.student_email = us.email
               JOIN classes c        ON c.id = cm.class_id
              WHERE c.church_id = $1)                                                 AS total_quiz_completions,
            (SELECT COUNT(DISTINCT us.email)
               FROM user_scores us
               JOIN class_members cm ON cm.student_email = us.email
               JOIN classes c        ON c.id = cm.class_id
              WHERE c.church_id = $1
                AND us.completed_at >= NOW() - ($2 || ' days')::interval)             AS active_learners,
            (SELECT COALESCE(SUM(points), 0) FROM teacher_marks WHERE church_id = $1) AS total_points_awarded
        `, [cid, String(days)]),
        db.query(`
          SELECT date_trunc('day', us.completed_at)::date AS day, COUNT(*) AS completions
            FROM user_scores us
            JOIN class_members cm ON cm.student_email = us.email
            JOIN classes c        ON c.id = cm.class_id
           WHERE c.church_id = $1
             AND us.completed_at >= NOW() - ($2 || ' days')::interval
           GROUP BY day
           ORDER BY day ASC
        `, [cid, String(days)]),
        db.query(`
          SELECT date_trunc('day', awarded_at)::date AS day, COUNT(*) AS signups
            FROM teacher_marks
           WHERE church_id = $1
             AND awarded_at >= NOW() - ($2 || ' days')::interval
           GROUP BY day
           ORDER BY day ASC
        `, [cid, String(days)]),
        db.query(`
          SELECT category, COUNT(*) AS active, COUNT(*) AS total
            FROM classes WHERE church_id = $1
           GROUP BY category
           ORDER BY active DESC
        `, [cid]),
      ]);
      return res.json({
        windowDays:        days,
        totals:            totals.rows[0],
        completionsDaily:  completionsDaily.rows,
        signupsDaily:      marksDaily.rows,    // re-purposed: marks-awarded daily for church view
        subsByCategory:    classes.rows,        // re-purposed: classes-by-category for church view
      });
    }

    // Super-admin (no church scope) — global metrics.
    const [totals, completionsDaily, signupsDaily, subsByCategory] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM users)                                      AS total_users,
          (SELECT COUNT(*) FROM subscribers WHERE is_active = TRUE
              AND (expiry_date IS NULL OR expiry_date > NOW()))             AS active_subscribers,
          (SELECT COUNT(*) FROM user_scores)                                AS total_quiz_completions,
          (SELECT COUNT(DISTINCT email) FROM user_scores
              WHERE completed_at >= NOW() - ($1 || ' days')::interval)      AS active_learners,
          (SELECT COALESCE(SUM(max_score), 0) FROM user_scores)             AS total_points_earned
      `, [String(days)]),
      db.query(`
        SELECT date_trunc('day', completed_at)::date AS day, COUNT(*) AS completions
          FROM user_scores
         WHERE completed_at >= NOW() - ($1 || ' days')::interval
         GROUP BY day
         ORDER BY day ASC
      `, [String(days)]),
      db.query(`
        SELECT date_trunc('day', subscription_date)::date AS day, COUNT(*) AS signups
          FROM subscribers
         WHERE subscription_date >= NOW() - ($1 || ' days')::interval
         GROUP BY day
         ORDER BY day ASC
      `, [String(days)]),
      db.query(`
        SELECT subscribed_category AS category,
               COUNT(*) FILTER (WHERE is_active = TRUE
                                 AND (expiry_date IS NULL OR expiry_date > NOW())) AS active,
               COUNT(*)                                                              AS total
          FROM subscribers
         GROUP BY subscribed_category
         ORDER BY active DESC
      `),
    ]);
    res.json({
      windowDays:        days,
      totals:            totals.rows[0],
      completionsDaily:  completionsDaily.rows,
      signupsDaily:      signupsDaily.rows,
      subsByCategory:    subsByCategory.rows,
    });
  } catch (e) {
    console.error('insights/engagement:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load engagement insights.' });
  }
});

// 3. Most completed lessons — top N by completion count, with avg score.
router.get('/api/admin/insights/most-completed-lessons', churchAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  try {
    if (req.church) {
      const r = await db.query(`
        SELECT l.id, l.lesson_number, l.title, l.category_id, l.lesson_date,
               COUNT(us.id)                                              AS completions,
               COUNT(DISTINCT us.email)                                  AS unique_learners,
               ROUND(AVG(us.score)::numeric, 1)                          AS avg_score,
               ROUND(AVG(NULLIF(us.max_score, 0))::numeric, 1)           AS avg_max_score,
               MAX(us.completed_at)                                      AS last_completed
          FROM lessons l
          JOIN user_scores us    ON us.lesson_id = l.id
          JOIN class_members cm  ON cm.student_email = us.email
          JOIN classes c         ON c.id = cm.class_id
         WHERE c.church_id = $2
         GROUP BY l.id
         ORDER BY completions DESC, unique_learners DESC
         LIMIT $1
      `, [limit, req.church.id]);
      return res.json(r.rows);
    }
    const r = await db.query(`
      SELECT l.id, l.lesson_number, l.title, l.category_id, l.lesson_date,
             COUNT(us.id)                                              AS completions,
             COUNT(DISTINCT us.email)                                  AS unique_learners,
             ROUND(AVG(us.score)::numeric, 1)                          AS avg_score,
             ROUND(AVG(NULLIF(us.max_score, 0))::numeric, 1)           AS avg_max_score,
             MAX(us.completed_at)                                      AS last_completed
        FROM lessons l
        LEFT JOIN user_scores us ON us.lesson_id = l.id
       GROUP BY l.id
      HAVING COUNT(us.id) > 0
       ORDER BY completions DESC, unique_learners DESC
       LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch (e) {
    console.error('insights/most-completed-lessons:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load lesson completions.' });
  }
});

// 4. Teacher performance — per-teacher rollup. Source of truth is the `users`
//    table so a teacher with zero classes still appears (with all-zero stats).
router.get('/api/admin/insights/teacher-performance', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  const params = [String(days)];
  let where = `WHERE u.role = 'teacher'`;
  if (req.church) {
    params.push(req.church.id);
    where += ` AND u.church_id = $${params.length}`;
  }
  try {
    const r = await db.query(`
      SELECT
        u.email                                                          AS teacher_email,
        COALESCE(up.display_name, u.full_name, split_part(u.email,'@',1)) AS display_name,
        COALESCE(up.avatar_emoji, '👤')                                  AS avatar_emoji,
        COALESCE(u.approval_status, 'approved')                          AS approval_status,
        u.created_at                                                     AS joined_at,
        COUNT(DISTINCT c.id)                                             AS classes_owned,
        COUNT(DISTINCT cm.student_email)                                 AS students_enrolled,
        COUNT(tm.id) FILTER
          (WHERE tm.awarded_at >= NOW() - ($1 || ' days')::interval)     AS marks_awarded_recent,
        COALESCE(SUM(tm.points) FILTER
          (WHERE tm.awarded_at >= NOW() - ($1 || ' days')::interval), 0) AS points_awarded_recent,
        COUNT(tm.id)                                                     AS marks_awarded_total,
        COALESCE(SUM(tm.points), 0)                                      AS points_awarded_total,
        MAX(tm.awarded_at)                                               AS last_active
      FROM users u
      LEFT JOIN classes        c  ON c.teacher_email = u.email
      LEFT JOIN class_members  cm ON cm.class_id = c.id
      LEFT JOIN teacher_marks  tm ON tm.class_id = c.id
      LEFT JOIN user_profiles  up ON up.email   = u.email
      ${where}
      GROUP BY u.email, u.full_name, u.approval_status, u.created_at, up.display_name, up.avatar_emoji
      ORDER BY marks_awarded_recent DESC NULLS LAST, classes_owned DESC, u.created_at DESC
    `, params);
    res.json({ windowDays: days, teachers: r.rows });
  } catch (e) {
    console.error('insights/teacher-performance:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load teacher performance.' });
  }
});

// 5. Top engaged learners — recency-weighted (only counts activity in window).
router.get('/api/admin/insights/top-learners', churchAuth, async (req, res) => {
  const days  = insightsWindow(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    if (req.church) {
      const r = await db.query(`
        SELECT us.email,
               COALESCE(up.display_name, split_part(us.email, '@', 1)) AS display_name,
               COALESCE(up.avatar_emoji, '👤')                          AS avatar_emoji,
               COALESCE(up.church, '')                                  AS church,
               COUNT(DISTINCT us.lesson_id)                              AS lessons_completed,
               COALESCE(SUM(us.score), 0)                                AS total_score,
               MAX(us.completed_at)                                      AS last_active
          FROM user_scores us
          JOIN class_members cm ON cm.student_email = us.email
          JOIN classes c        ON c.id = cm.class_id
          LEFT JOIN user_profiles up ON up.email = us.email
         WHERE us.completed_at >= NOW() - ($1 || ' days')::interval
           AND c.church_id = $3
         GROUP BY us.email, up.display_name, up.avatar_emoji, up.church
         ORDER BY lessons_completed DESC, total_score DESC
         LIMIT $2
      `, [String(days), limit, req.church.id]);
      return res.json({ windowDays: days, learners: r.rows });
    }
    const r = await db.query(`
      SELECT us.email,
             COALESCE(up.display_name, split_part(us.email, '@', 1)) AS display_name,
             COALESCE(up.avatar_emoji, '👤')                          AS avatar_emoji,
             COALESCE(up.church, '')                                  AS church,
             COUNT(DISTINCT us.lesson_id)                              AS lessons_completed,
             COALESCE(SUM(us.score), 0)                                AS total_score,
             MAX(us.completed_at)                                      AS last_active
        FROM user_scores us
        LEFT JOIN user_profiles up ON up.email = us.email
       WHERE us.completed_at >= NOW() - ($1 || ' days')::interval
       GROUP BY us.email, up.display_name, up.avatar_emoji, up.church
       ORDER BY lessons_completed DESC, total_score DESC
       LIMIT $2
    `, [String(days), limit]);
    res.json({ windowDays: days, learners: r.rows });
  } catch (e) {
    console.error('insights/top-learners:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load top learners.' });
  }
});

// 6. Per-category lesson stats — avg score, completion rate per age group.
router.get('/api/admin/insights/lesson-categories', churchAuth, async (req, res) => {
  try {
    if (req.church) {
      const r = await db.query(`
        SELECT l.category_id                                                  AS category,
               COUNT(DISTINCT l.id)                                           AS total_lessons,
               COUNT(DISTINCT us.lesson_id)                                   AS lessons_attempted,
               COUNT(us.id)                                                   AS total_completions,
               COUNT(DISTINCT us.email)                                       AS unique_learners,
               ROUND(AVG(us.score)::numeric, 1)                               AS avg_score
          FROM lessons l
          LEFT JOIN user_scores us ON us.lesson_id = l.id
          LEFT JOIN class_members cm ON cm.student_email = us.email
          LEFT JOIN classes c        ON c.id = cm.class_id AND c.church_id = $1
         WHERE us.id IS NULL OR c.id IS NOT NULL
         GROUP BY l.category_id
         ORDER BY total_completions DESC NULLS LAST
      `, [req.church.id]);
      return res.json(r.rows);
    }
    const r = await db.query(`
      SELECT l.category_id                                                  AS category,
             COUNT(DISTINCT l.id)                                           AS total_lessons,
             COUNT(DISTINCT us.lesson_id)                                   AS lessons_attempted,
             COUNT(us.id)                                                   AS total_completions,
             COUNT(DISTINCT us.email)                                       AS unique_learners,
             ROUND(AVG(us.score)::numeric, 1)                               AS avg_score
        FROM lessons l
        LEFT JOIN user_scores us ON us.lesson_id = l.id
       GROUP BY l.category_id
       ORDER BY total_completions DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('insights/lesson-categories:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load category stats.' });
  }
});

// 7. Mark-type distribution — what teachers are awarding marks for.
router.get('/api/admin/insights/mark-distribution', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  const scope = churchScope(req, 2);
  try {
    const r = await db.query(`
      SELECT mark_type,
             COUNT(*)               AS count,
             COALESCE(SUM(points),0) AS total_points
        FROM teacher_marks
       WHERE awarded_at >= NOW() - ($1 || ' days')::interval${scope.sql}
       GROUP BY mark_type
       ORDER BY count DESC
    `, [String(days), ...scope.params]);
    res.json({ windowDays: days, breakdown: r.rows });
  } catch (e) {
    console.error('insights/mark-distribution:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load mark distribution.' });
  }
});

module.exports = router;
