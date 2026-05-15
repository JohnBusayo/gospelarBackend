// routes/teacher.js
// Teacher-app endpoints: classes, attendance, marks, plus the offline sync
// drain that turns AsyncStorage queues into real DB rows.

const express = require('express');
const db = require('../db');
const { isValidEmail, randCode } = require('../utils/helpers');

const router = express.Router();

router.post('/api/teacher/classes', async (req, res) => {
  const { teacher_email, name, description, category } = req.body;
  if (!teacher_email || !name) return res.status(400).json({ error: 'teacher_email and name required.' });
  try {
    const invite_code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const r = await db.query(
      'INSERT INTO classes (teacher_email,name,description,category,invite_code) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [teacher_email, name, description || '', category || 'adult', invite_code]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/teacher/classes', async (req, res) => {
  const { teacher_email } = req.query;
  if (!teacher_email) return res.status(400).json({ error: 'teacher_email required.' });
  try {
    const r = await db.query(
      `SELECT c.*, COUNT(DISTINCT cm.student_email) AS student_count
       FROM classes c LEFT JOIN class_members cm ON cm.class_id=c.id
       WHERE c.teacher_email=$1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [teacher_email]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/teacher/classes/:classId/members', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT cm.student_email, cm.joined_at, COALESCE(up.display_name,cm.student_email) AS display_name, up.avatar_emoji
       FROM class_members cm LEFT JOIN user_profiles up ON up.email=cm.student_email
       WHERE cm.class_id=$1 ORDER BY display_name`,
      [req.params.classId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/teacher/classes/join', async (req, res) => {
  const { invite_code, student_email } = req.body;
  if (!invite_code || !student_email) return res.status(400).json({ error: 'invite_code and student_email required.' });
  try {
    const cls = await db.query('SELECT * FROM classes WHERE invite_code=$1', [invite_code.toUpperCase()]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Invalid invite code.' });
    await db.query(
      'INSERT INTO class_members (class_id,student_email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [cls.rows[0].id, student_email]
    );
    res.json({ message: 'Joined class.', class: cls.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Teacher-initiated add (by email). Verifies the requesting teacher actually
// owns the class — prevents one teacher altering another's roster.
router.post('/api/teacher/classes/:classId/add-student', async (req, res) => {
  const classId = parseInt(req.params.classId, 10);
  const { teacher_email, student_email } = req.body || {};
  if (!teacher_email || !student_email) {
    return res.status(400).json({ error: 'teacher_email and student_email are required.' });
  }
  const email = String(student_email).trim().toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid student email.' });
  try {
    const cls = await db.query('SELECT * FROM classes WHERE id=$1', [classId]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Class not found.' });
    if (cls.rows[0].teacher_email?.toLowerCase() !== teacher_email.toLowerCase()) {
      return res.status(403).json({ error: 'Only the class owner can add students.' });
    }
    const dup = await db.query(
      'SELECT 1 FROM class_members WHERE class_id=$1 AND student_email=$2',
      [classId, email]
    );
    if (dup.rows.length) return res.status(409).json({ error: 'Student is already in this class.' });
    await db.query(
      'INSERT INTO class_members (class_id,student_email) VALUES ($1,$2)',
      [classId, email]
    );
    const profile = await db.query(
      'SELECT display_name, avatar_emoji FROM user_profiles WHERE email=$1', [email]
    );
    res.status(201).json({
      message: 'Student added.',
      student: {
        student_email: email,
        display_name:  profile.rows[0]?.display_name || email,
        avatar_emoji:  profile.rows[0]?.avatar_emoji || null,
      },
    });
  } catch (e) {
    console.error('teacher/add-student:', e.message);
    res.status(500).json({ error: 'Failed to add student.' });
  }
});

router.delete('/api/teacher/classes/:classId/members/:email', async (req, res) => {
  const classId = parseInt(req.params.classId, 10);
  const email   = decodeURIComponent(req.params.email).toLowerCase();
  const teacher_email = (req.query.teacher_email || '').toLowerCase();
  if (!teacher_email) return res.status(400).json({ error: 'teacher_email query required.' });
  try {
    const cls = await db.query('SELECT teacher_email FROM classes WHERE id=$1', [classId]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Class not found.' });
    if (cls.rows[0].teacher_email?.toLowerCase() !== teacher_email) {
      return res.status(403).json({ error: 'Only the class owner can remove students.' });
    }
    await db.query('DELETE FROM class_members WHERE class_id=$1 AND student_email=$2', [classId, email]);
    res.json({ message: 'Student removed.' });
  } catch (e) {
    console.error('teacher/remove-student:', e.message);
    res.status(500).json({ error: 'Failed to remove student.' });
  }
});

router.get('/api/teacher/attendance', async (req, res) => {
  const { class_id, lesson_number } = req.query;
  if (!class_id) return res.status(400).json({ error: 'class_id required.' });
  try {
    const r = await db.query(
      `SELECT cm.student_email, COALESCE(up.display_name,cm.student_email) AS display_name,
              up.avatar_emoji, COALESCE(a.present,false) AS present, a.marked_at
       FROM class_members cm
       LEFT JOIN user_profiles up ON up.email=cm.student_email
       LEFT JOIN attendance a ON a.class_id=cm.class_id AND a.student_email=cm.student_email AND a.lesson_number=$2
       WHERE cm.class_id=$1 ORDER BY display_name`,
      [class_id, lesson_number || 1]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/teacher/attendance/bulk', async (req, res) => {
  const { class_id, lesson_number, records, marked_by } = req.body;
  if (!class_id || !lesson_number || !Array.isArray(records)) return res.status(400).json({ error: 'Missing fields.' });
  try {
    for (const rec of records) {
      await db.query(
        `INSERT INTO attendance (class_id,lesson_number,student_email,present,marked_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (class_id,lesson_number,student_email) DO UPDATE SET present=$4,marked_by=$5,marked_at=NOW()`,
        [class_id, lesson_number, rec.student_email, !!rec.present, marked_by || '']
      );
    }
    res.json({ message: `${records.length} records saved.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/teacher/marks', async (req, res) => {
  const { class_id, lesson_number } = req.query;
  if (!class_id) return res.status(400).json({ error: 'class_id required.' });
  try {
    const extra  = lesson_number ? ' AND tm.lesson_number=$2' : '';
    const params = lesson_number ? [class_id, lesson_number] : [class_id];
    const r = await db.query(
      `SELECT tm.*, COALESCE(up.display_name,tm.student_email) AS display_name, up.avatar_emoji
       FROM teacher_marks tm LEFT JOIN user_profiles up ON up.email=tm.student_email
       WHERE tm.class_id=$1${extra} ORDER BY tm.awarded_at DESC`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/teacher/marks', async (req, res) => {
  const { class_id, lesson_number, student_email, mark_type, points, note, awarded_by } = req.body;
  if (!class_id || !lesson_number || !student_email || !mark_type) return res.status(400).json({ error: 'Missing fields.' });
  try {
    const r = await db.query(
      'INSERT INTO teacher_marks (class_id,lesson_number,student_email,mark_type,points,note,awarded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [class_id, lesson_number, student_email, mark_type, points || 0, note || '', awarded_by || '']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/teacher/marks/:markId', async (req, res) => {
  try { await db.query('DELETE FROM teacher_marks WHERE id=$1', [req.params.markId]); res.json({ message: 'Mark removed.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Offline sync — drains the teacher's local AsyncStorage queue.
// Body: {
//   teacher_email,
//   classes:    [{ local_id, name, description, category, ... }],
//   roster:     [{ local_class_id?, server_class_id?, name, email? }],
//   attendance: [{ local_class_id?, server_class_id?, lesson_number, student_local_id, student_email?, present, marked_at }],
//   marks:      [{ local_class_id?, server_class_id?, lesson_number, student_local_id, student_email?, mark_type, points, note, awarded_at }],
// }
// Returns { ok, mappings: { classes: { localId: serverId }, students: { localId: email } } }
// The mappings let the client mark its local rows synced + remember the
// server IDs so subsequent syncs use them directly.
router.post('/api/teacher/sync', async (req, res) => {
  const { teacher_email, classes = [], roster = [], attendance = [], marks = [] } = req.body || {};
  if (!teacher_email) return res.status(400).json({ error: 'teacher_email required.' });

  // Look up teacher's church_id once — every record gets stamped with it.
  // Two-step lookup separates "no such email" from "exists but not a teacher".
  const u = await db.query('SELECT role, church_id FROM users WHERE email = $1', [teacher_email.toLowerCase()]);
  if (!u.rows.length) {
    return res.status(404).json({ code: 'no_account', error: 'No account found for this email on the server. Register a teacher account first.' });
  }
  if (u.rows[0].role !== 'teacher') {
    return res.status(403).json({ code: 'not_a_teacher', error: 'This account is not a teacher account. Re-register as a teacher with your church invite code to sync.' });
  }
  const churchId = u.rows[0].church_id;
  if (!churchId) {
    return res.status(400).json({ code: 'no_church', error: 'Teacher is not assigned to a church. Re-register with your church invite code.' });
  }

  const classMap   = {};   // local_id → server_id
  const studentMap = {};   // local_id → email (synth for name-only roster entries)

  try {
    // 1. Classes — create new ones the teacher made offline.
    for (const c of classes) {
      if (!c?.local_id || !c?.name) continue;
      let inviteCode, attempts = 0;
      while (attempts++ < 8) {
        inviteCode = randCode(6);
        const dup = await db.query('SELECT 1 FROM classes WHERE invite_code = $1', [inviteCode]);
        if (!dup.rows.length) break;
      }
      const r = await db.query(`
        INSERT INTO classes (teacher_email, name, description, category, invite_code, church_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [teacher_email.toLowerCase(), c.name, c.description || null, c.category || 'adult', inviteCode, churchId]);
      classMap[c.local_id] = r.rows[0].id;
    }

    const resolveClassId = (rec) =>
      rec.server_class_id || classMap[rec.local_class_id] || null;

    // 2. Roster — for name-only students (no email), synthesize a stable
    //    pseudo-email so class_members has something to key on.
    const synthEmail = (teacherEmail, localId) =>
      `local_${teacherEmail.replace(/[^a-z0-9]/g, '')}_${localId}@local.gofamint`;

    for (const m of roster) {
      const classId = resolveClassId(m);
      if (!classId || !m.local_id) continue;
      const email = (m.email && m.email.toLowerCase()) || synthEmail(teacher_email, m.local_id);
      studentMap[m.local_id] = email;
      if (m.name) {
        await db.query(`
          INSERT INTO user_profiles (email, display_name)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
        `, [email, m.name]);
      }
      await db.query(
        'INSERT INTO class_members (class_id, student_email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [classId, email]
      );
    }

    // 3. Attendance.
    let attendanceWritten = 0;
    for (const a of attendance) {
      const classId = resolveClassId(a);
      const email   = (a.student_email && a.student_email.toLowerCase())
                   || studentMap[a.student_local_id];
      if (!classId || !email || !a.lesson_number) continue;
      await db.query(`
        INSERT INTO attendance (class_id, lesson_number, student_email, present, marked_by, marked_at, church_id)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7)
        ON CONFLICT (class_id, lesson_number, student_email) DO UPDATE SET
          present = EXCLUDED.present, marked_at = EXCLUDED.marked_at, marked_by = EXCLUDED.marked_by
      `, [classId, a.lesson_number, email, !!a.present, teacher_email.toLowerCase(), a.marked_at || null, churchId]);
      attendanceWritten++;
    }

    // 4. Teacher marks.
    let marksWritten = 0;
    for (const m of marks) {
      const classId = resolveClassId(m);
      const email   = (m.student_email && m.student_email.toLowerCase())
                   || studentMap[m.student_local_id];
      if (!classId || !email || !m.lesson_number || !m.mark_type) continue;
      await db.query(`
        INSERT INTO teacher_marks (class_id, lesson_number, student_email, mark_type, points, note, awarded_by, awarded_at, church_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), $9)
      `, [classId, m.lesson_number, email, m.mark_type, parseInt(m.points, 10) || 0, m.note || null, teacher_email.toLowerCase(), m.awarded_at || null, churchId]);
      marksWritten++;
    }

    res.json({
      ok: true,
      church_id: churchId,
      mappings:   { classes: classMap, students: studentMap },
      counts:     { classes: Object.keys(classMap).length, roster: roster.length, attendance: attendanceWritten, marks: marksWritten },
    });
  } catch (e) {
    console.error('teacher/sync:', e.code, e.message);
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

router.get('/api/teacher/progress', async (req, res) => {
  const { class_id } = req.query;
  if (!class_id) return res.status(400).json({ error: 'class_id required.' });
  try {
    const r = await db.query(`
      SELECT cm.student_email,
        COALESCE(up.display_name,cm.student_email) AS display_name, up.avatar_emoji,
        COUNT(DISTINCT a.lesson_number) FILTER (WHERE a.present=TRUE) AS lessons_attended,
        COUNT(DISTINCT a.lesson_number) AS lessons_marked,
        COALESCE((SELECT SUM(us2.max_score) FROM user_scores us2 WHERE us2.email=cm.student_email),0) AS quiz_total,
        COALESCE((SELECT SUM(tm2.points) FROM teacher_marks tm2 WHERE tm2.class_id=$1 AND tm2.student_email=cm.student_email),0) AS teacher_points
      FROM class_members cm
      LEFT JOIN user_profiles up ON up.email=cm.student_email
      LEFT JOIN attendance a ON a.class_id=cm.class_id AND a.student_email=cm.student_email
      WHERE cm.class_id=$1
      GROUP BY cm.student_email, up.display_name, up.avatar_emoji
      ORDER BY (quiz_total+teacher_points) DESC
    `, [class_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
