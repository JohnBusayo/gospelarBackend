// routes/lessons.js
// Units + lessons + quiz + leaderboard + progress. Public reads (no auth)
// match the trust model of the rest of the read API; admin writes are
// adminAuth-gated. All multi-language reads route through utils/lessons.js
// (mergeLesson + LESSON_SELECT) so per-language fallbacks behave consistently.

const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');
const {
  mergeLesson, LESSON_SELECT,
  saveUnitTranslations, saveLessonTranslations,
} = require('../utils/lessons');

const router = express.Router();

// ── Units ──────────────────────────────────────────────────────────────────
router.get('/api/units', async (req, res) => {
  const { category, lang = 'en' } = req.query;
  try {
    const baseQ = `
      SELECT u.id, u.category_id, u.color, u.sort_order,
        COALESCE(ut.title,        u.title)        AS title,
        COALESCE(ut.description,  u.description)  AS description,
        COALESCE(ut.lesson_range, u.lesson_range) AS lesson_range
      FROM units u
      LEFT JOIN unit_translations ut ON ut.unit_id=u.id AND ut.lang_code=$1
    `;
    const r = category
      ? await db.query(baseQ + ' WHERE u.category_id=$2 ORDER BY u.sort_order,u.id', [lang, category])
      : await db.query(baseQ + ' ORDER BY u.category_id,u.sort_order,u.id', [lang]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch units.' }); }
});

router.get('/api/admin/units/:id', adminAuth, async (req, res) => {
  try {
    const unit  = await db.query('SELECT * FROM units WHERE id=$1', [req.params.id]);
    if (!unit.rows.length) return res.status(404).json({ error: 'Unit not found.' });
    const trans = await db.query('SELECT * FROM unit_translations WHERE unit_id=$1', [req.params.id]);
    const translations = {};
    trans.rows.forEach((t) => {
      translations[t.lang_code] = { title: t.title, description: t.description, lesson_range: t.lesson_range };
    });
    res.json({ ...unit.rows[0], translations });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch unit.' }); }
});

router.post('/api/admin/units', adminAuth, async (req, res) => {
  const { id, category_id, title, description, lesson_range, color, sort_order, translations = {} } = req.body;
  if (!id || !title || !category_id) return res.status(400).json({ error: 'id, category_id, title required.' });
  try {
    const r = await db.query(
      `INSERT INTO units (id,category_id,title,description,lesson_range,color,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET category_id=EXCLUDED.category_id, title=EXCLUDED.title,
         description=EXCLUDED.description, lesson_range=EXCLUDED.lesson_range,
         color=EXCLUDED.color, sort_order=EXCLUDED.sort_order RETURNING *`,
      [id, category_id, title, description || null, lesson_range || null, color || null, sort_order || 1]
    );
    await saveUnitTranslations(id, translations);
    res.status(201).json({ ...r.rows[0], translations });
  } catch (e) { console.error('admin/units POST:', e.message); res.status(500).json({ error: 'Failed to save unit.' }); }
});

router.put('/api/admin/units/:id', adminAuth, async (req, res) => {
  const { category_id, title, description, lesson_range, color, sort_order, translations = {} } = req.body;
  if (!title) return res.status(400).json({ error: 'title required.' });
  try {
    const r = await db.query(
      `UPDATE units SET category_id=COALESCE($1,category_id), title=$2, description=$3,
         lesson_range=$4, color=$5, sort_order=$6 WHERE id=$7 RETURNING *`,
      [category_id || null, title, description || null, lesson_range || null, color || null, sort_order || 1, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unit not found.' });
    await saveUnitTranslations(req.params.id, translations);
    res.json({ ...r.rows[0], translations });
  } catch (e) { res.status(500).json({ error: 'Failed to update unit.' }); }
});

router.delete('/api/admin/units/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM units WHERE id=$1', [req.params.id]);
    res.json({ message: 'Unit deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed to delete unit.' }); }
});

// ── Lessons (public) ───────────────────────────────────────────────────────
router.get('/api/lessons/preview', async (req, res) => {
  const { category = 'adult', lang = 'en', limit = 4 } = req.query;
  const max = Math.min(parseInt(limit, 10) || 4, 20);
  try {
    const r = await db.query(`
      SELECT l.id, l.lesson_number, l.memory_verse_passage,
             COALESCE(lt.title,l.title) AS title
      FROM lessons l
      LEFT JOIN lesson_translations lt ON lt.lesson_id=l.id AND lt.lang_code=$1
      WHERE l.category_id=$2 ORDER BY l.lesson_number ASC LIMIT $3
    `, [lang, category, max]);
    res.json(r.rows.map((r) => ({ id: r.id, lessonNumber: r.lesson_number, title: r.title || '', scripture: r.memory_verse_passage || '' })));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch preview lessons.' }); }
});

router.get('/api/units/:unitId/lessons', async (req, res) => {
  const lang = req.query.lang || 'en';
  try {
    const r = await db.query(
      LESSON_SELECT + ` WHERE l.unit_id=$2 ORDER BY l.sort_order, l.lesson_number`,
      [lang, req.params.unitId]
    );
    res.json(r.rows.map(mergeLesson));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch lessons for unit.' }); }
});

router.get('/api/lessons/by-number/:number', async (req, res) => {
  const { category = 'adult', lang = 'en' } = req.query;
  try {
    const r = await db.query(
      LESSON_SELECT + ` WHERE l.lesson_number=$2 AND l.category_id=$3 LIMIT 1`,
      [lang, req.params.number, category]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lesson not found.' });
    res.json(mergeLesson(r.rows[0]));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch lesson.' }); }
});

router.get('/api/lessons/:id', async (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const lang = req.query.lang || 'en';
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid lesson id.' });
  try {
    const r = await db.query(LESSON_SELECT + ` WHERE l.id=$2`, [lang, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Lesson not found.' });
    res.json(mergeLesson(r.rows[0]));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch lesson.' }); }
});

// ── Lessons (admin CRUD) ──────────────────────────────────────────────────
router.get('/api/admin/lessons/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const lr = await db.query('SELECT * FROM lessons WHERE id=$1', [id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Lesson not found.' });
    const tr = await db.query('SELECT * FROM lesson_translations WHERE lesson_id=$1', [id]);
    const translations = {};
    tr.rows.forEach((t) => { translations[t.lang_code] = t; });
    res.json({ ...lr.rows[0], translations });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch lesson.' }); }
});

router.post('/api/admin/lessons', adminAuth, async (req, res) => {
  const {
    unit_id, lesson_number, title, lesson_date, topic, quarter_theme,
    suggested_hymns, devotional_reading, memory_verse, memory_verse_passage,
    sort_order, content = {},
  } = req.body;
  if (!unit_id || !title) return res.status(400).json({ error: 'unit_id and title required.' });
  try {
    const uR = await db.query('SELECT category_id FROM units WHERE id=$1', [unit_id]);
    if (!uR.rows.length) return res.status(400).json({ error: 'Unit not found.' });
    const category_id = uR.rows[0].category_id;
    const en = content.en || {};
    const r = await db.query(`
      INSERT INTO lessons
        (unit_id,category_id,lesson_number,title,lesson_date,topic,quarter_theme,
         suggested_hymns,devotional_reading,memory_verse,memory_verse_passage,
         lesson_background,lesson_conclusion,lesson_part,devotional_days,questions,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17)
      RETURNING *
    `, [
      unit_id, category_id, lesson_number || null, title, lesson_date || null, topic || null,
      quarter_theme || null, suggested_hymns || null, devotional_reading || null,
      en.memory_verse || memory_verse || null, memory_verse_passage || null,
      en.background || null, en.conclusion || null,
      JSON.stringify(en.lesson_part || []),
      JSON.stringify(en.devotional_days || []),
      JSON.stringify(en.questions || []),
      sort_order || 0,
    ]);
    await saveLessonTranslations(r.rows[0].id, content);
    res.status(201).json({ ...r.rows[0], message: 'Lesson created.' });
  } catch (e) {
    console.error('admin/lessons POST:', e.message);
    res.status(500).json({ error: 'Failed to create lesson: ' + e.message });
  }
});

router.put('/api/admin/lessons/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    unit_id, lesson_number, title, lesson_date, topic, quarter_theme,
    suggested_hymns, devotional_reading, memory_verse, memory_verse_passage,
    sort_order, content = {},
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required.' });
  try {
    const en = content.en || {};
    let category_id = null;
    if (unit_id) {
      const uR = await db.query('SELECT category_id FROM units WHERE id=$1', [unit_id]);
      if (uR.rows.length) category_id = uR.rows[0].category_id;
    }
    const r = await db.query(`
      UPDATE lessons SET
        unit_id=COALESCE($1,unit_id), category_id=COALESCE($2,category_id),
        lesson_number=COALESCE($3,lesson_number), title=$4, lesson_date=$5,
        topic=$6, quarter_theme=$7, suggested_hymns=$8, devotional_reading=$9,
        memory_verse=$10, memory_verse_passage=$11,
        lesson_background=$12, lesson_conclusion=$13,
        lesson_part=$14::jsonb, devotional_days=$15::jsonb, questions=$16::jsonb,
        sort_order=COALESCE($17,sort_order)
      WHERE id=$18 RETURNING *
    `, [
      unit_id || null, category_id, lesson_number || null, title, lesson_date || null,
      topic || null, quarter_theme || null, suggested_hymns || null, devotional_reading || null,
      en.memory_verse || memory_verse || null, memory_verse_passage || null,
      en.background || null, en.conclusion || null,
      JSON.stringify(en.lesson_part || []),
      JSON.stringify(en.devotional_days || []),
      JSON.stringify(en.questions || []),
      sort_order ?? null, id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Lesson not found.' });
    await saveLessonTranslations(id, content);
    res.json({ ...r.rows[0], message: 'Lesson updated.' });
  } catch (e) {
    console.error('admin/lessons PUT:', e.message);
    res.status(500).json({ error: 'Failed to update lesson.' });
  }
});

router.delete('/api/admin/lessons/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM lessons WHERE id=$1', [req.params.id]);
    res.json({ message: 'Lesson deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed to delete lesson.' }); }
});

// ── Quiz ───────────────────────────────────────────────────────────────────
router.get('/api/quiz/:lessonId', async (req, res) => {
  try {
    const { category, lang } = req.query;
    let query  = 'SELECT * FROM lesson_quizzes WHERE lesson_id=$1';
    const params = [req.params.lessonId];
    if (category && category !== 'all') {
      params.push(category);
      query += ` AND (category_id='all' OR category_id=$${params.length})`;
    }
    if (lang && lang !== 'en') {
      params.push(lang);
      query += ` AND (lang='en' OR lang=$${params.length})`;
    }
    query += ' ORDER BY id';
    res.json((await db.query(query, params)).rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch quiz.' }); }
});

router.post('/api/quiz/submit', async (req, res) => {
  const { email, lessonId, score } = req.body;
  if (!email || !lessonId || score === undefined) return res.status(400).json({ error: 'email, lessonId, score required.' });
  try {
    const r = await db.query(`
      INSERT INTO user_scores (email,lesson_id,score,max_score,completed_at)
      VALUES ($1,$2,$3,$3,NOW())
      ON CONFLICT (email,lesson_id) DO UPDATE SET
        score=EXCLUDED.score,
        max_score=GREATEST(user_scores.max_score,EXCLUDED.score),
        completed_at=NOW()
      RETURNING score, max_score
    `, [email, lessonId, score]);
    const t = await db.query(
      'SELECT SUM(COALESCE(max_score,score)) AS tp, COUNT(DISTINCT lesson_id) AS lc FROM user_scores WHERE email=$1',
      [email]
    );
    res.json({
      message: 'Score saved!', score: r.rows[0].score, bestScore: r.rows[0].max_score,
      totalPoints: parseInt(t.rows[0].tp || 0, 10),
      lessonsCompleted: parseInt(t.rows[0].lc || 0, 10),
    });
  } catch (e) { res.status(500).json({ error: 'Failed to save score.' }); }
});

router.post('/api/admin/quiz', adminAuth, async (req, res) => {
  const { lesson_id, question, options, correct_answer, points, category_id, lang } = req.body;
  if (!lesson_id || !question || !correct_answer) return res.status(400).json({ error: 'lesson_id, question, correct_answer required.' });
  try {
    const r = await db.query(
      `INSERT INTO lesson_quizzes (lesson_id,question,options,correct_answer,points,category_id,lang)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING *`,
      [lesson_id, question, JSON.stringify(options || {}), correct_answer, points || 10, category_id || 'all', lang || 'en']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to create question.' }); }
});

router.put('/api/admin/quiz/:id', adminAuth, async (req, res) => {
  const { lesson_id, question, options, correct_answer, points, category_id, lang } = req.body;
  try {
    const r = await db.query(
      `UPDATE lesson_quizzes SET
         lesson_id=COALESCE($1,lesson_id), question=COALESCE($2,question),
         options=COALESCE($3::jsonb,options), correct_answer=COALESCE($4,correct_answer),
         points=COALESCE($5,points), category_id=COALESCE($6,category_id), lang=COALESCE($7,lang)
       WHERE id=$8 RETURNING *`,
      [lesson_id || null, question || null, options ? JSON.stringify(options) : null,
       correct_answer || null, points || null, category_id || null, lang || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Question not found.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to update question.' }); }
});

router.delete('/api/admin/quiz/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM lesson_quizzes WHERE id=$1', [req.params.id]);
    res.json({ message: 'Question deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed to delete question.' }); }
});

// ── Leaderboard & progress ────────────────────────────────────────────────
router.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    const r = await db.query(`
      SELECT us.email,
        COALESCE(up.display_name, split_part(us.email,'@',1)) AS display_name,
        COALESCE(up.avatar_emoji,'👤') AS avatar_emoji,
        COALESCE(up.church,'')         AS church,
        SUM(COALESCE(us.max_score,us.score)) AS total_points,
        COUNT(DISTINCT us.lesson_id)         AS lessons_completed,
        MAX(us.completed_at)                 AS last_activity,
        RANK() OVER (ORDER BY SUM(COALESCE(us.max_score,us.score)) DESC) AS rank
      FROM user_scores us
      LEFT JOIN user_profiles up ON up.email=us.email
      GROUP BY us.email, up.display_name, up.avatar_emoji, up.church
      ORDER BY total_points DESC LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch leaderboard.' }); }
});

router.get('/api/progress/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    // `score` in user_scores is sum of points earned, NOT count of correct
    // answers — so percent must divide by sum of question points (max_possible_score),
    // not the count of questions.
    const scores = await db.query(`
      SELECT us.lesson_id, us.score AS last_score, COALESCE(us.max_score,us.score) AS best_score,
             us.completed_at, l.lesson_number, l.title, l.topic, l.category_id,
             (SELECT COUNT(*) FROM lesson_quizzes WHERE lesson_id=us.lesson_id)::int AS total_questions,
             (SELECT COALESCE(SUM(points), 0) FROM lesson_quizzes WHERE lesson_id=us.lesson_id)::int AS max_possible_score
      FROM user_scores us JOIN lessons l ON l.id=us.lesson_id
      WHERE us.email=$1 ORDER BY l.lesson_number
    `, [email]);
    const totalLessons = await db.query('SELECT COUNT(*) FROM lessons');
    const prof         = await db.query('SELECT * FROM user_profiles WHERE email=$1', [email]);
    const rows         = scores.rows;
    const totalBest    = rows.reduce((s, r) => s + parseInt(r.best_score, 10), 0);
    const rankR = await db.query(`
      SELECT rank FROM (
        SELECT email, RANK() OVER (ORDER BY SUM(COALESCE(max_score,score)) DESC) AS rank
        FROM user_scores GROUP BY email
      ) t WHERE email=$1`, [email]);
    res.json({
      email, profile: prof.rows[0] || null,
      completedCount: rows.length, totalLessons: parseInt(totalLessons.rows[0].count, 10),
      totalPoints: totalBest,
      rank: rankR.rows[0] ? parseInt(rankR.rows[0].rank, 10) : null,
      lessons: rows.map((r) => {
        const best = parseInt(r.best_score, 10) || 0;
        const max  = parseInt(r.max_possible_score, 10) || 0;
        // Cap at 100 — if a question gets removed after submission, best can
        // exceed the new max and we don't want to show > 100% in the UI.
        const pct  = max > 0 ? Math.min(100, Math.round((best / max) * 100)) : 0;
        return {
          lessonId: r.lesson_id, lessonNumber: r.lesson_number, title: r.title, topic: r.topic,
          categoryId: r.category_id, lastScore: parseInt(r.last_score, 10), bestScore: best,
          totalQuestions: r.total_questions,
          maxPossibleScore: max,
          percent: pct,
          completedAt: r.completed_at,
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch progress.' }); }
});

module.exports = router;
