// routes/quarterInfo.js
// Quarter info + ad banners + bible verses. All admin writes are
// adminAuth-gated; reads are public.

const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');
const { saveQuarterTranslations } = require('../utils/lessons');

const router = express.Router();

// ── Quarter info ───────────────────────────────────────────────────────────
router.get('/api/quarter-info', async (req, res) => {
  const lang = req.query.lang || 'en';
  try {
    const r = await db.query(`
      SELECT qi.id, qi.quarter, qi.year, qi.theme_title, qi.theme_sub,
             qi.book, qi.book_full, qi.lesson_count, qi.period, qi.memory_verse,
             qt.theme_title  AS tr_theme_title,
             qt.theme_sub    AS tr_theme_sub,
             qt.period       AS tr_period,
             qt.memory_verse AS tr_memory_verse
      FROM quarter_info qi
      LEFT JOIN quarter_translations qt ON qt.quarter_id=qi.id AND qt.lang_code=$1
      WHERE qi.is_current=TRUE ORDER BY qi.id DESC LIMIT 1
    `, [lang]);
    if (!r.rows.length) {
      return res.json({
        quarter: 'Q4 2026', year: 2026,
        theme_title: 'Demonstration of the Christian Life',
        theme_sub: 'Exposition on the Book of Philemon',
        book: 'Philemon', book_full: 'Book of Philemon',
        lesson_count: 13, period: 'October – December 2026', memory_verse: 'Philemon 1:1–25',
      });
    }
    const row = r.rows[0];
    res.json({
      id: row.id, quarter: row.quarter, year: row.year,
      theme_title:  row.tr_theme_title  || row.theme_title,
      theme_sub:    row.tr_theme_sub    || row.theme_sub,
      book: row.book, book_full: row.book_full, lesson_count: row.lesson_count,
      period:       row.tr_period       || row.period,
      memory_verse: row.tr_memory_verse || row.memory_verse,
      lang,
    });
  } catch (e) { console.error('quarter-info:', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/api/admin/quarter-info', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM quarter_info ORDER BY id DESC');
    const quarters = await Promise.all(r.rows.map(async (q) => {
      const tr = await db.query('SELECT * FROM quarter_translations WHERE quarter_id=$1', [q.id]);
      const translations = {};
      tr.rows.forEach((row) => {
        translations[row.lang_code] = {
          theme_title: row.theme_title, theme_sub: row.theme_sub,
          period: row.period, memory_verse: row.memory_verse,
        };
      });
      return { ...q, translations };
    }));
    res.json(quarters);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/quarter-info', adminAuth, async (req, res) => {
  const { quarter, year, theme_title, theme_sub, book, book_full, lesson_count, period, memory_verse, is_current, translations } = req.body;
  if (!quarter || !theme_title) return res.status(400).json({ error: 'quarter and theme_title required.' });
  try {
    if (is_current) await db.query('UPDATE quarter_info SET is_current=FALSE');
    const r = await db.query(`
      INSERT INTO quarter_info
        (quarter,year,theme_title,theme_sub,book,book_full,lesson_count,period,memory_verse,is_current)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [quarter, year || 2026, theme_title, theme_sub || null, book || null, book_full || null, lesson_count || 13, period || null, memory_verse || null, is_current || false]);
    await saveQuarterTranslations(r.rows[0].id, translations);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/admin/quarter-info/:id', adminAuth, async (req, res) => {
  const { quarter, year, theme_title, theme_sub, book, book_full, lesson_count, period, memory_verse, is_current, translations } = req.body;
  try {
    if (is_current) await db.query('UPDATE quarter_info SET is_current=FALSE WHERE id!=$1', [req.params.id]);
    const r = await db.query(`
      UPDATE quarter_info SET quarter=$1,year=$2,theme_title=$3,theme_sub=$4,book=$5,book_full=$6,
        lesson_count=$7,period=$8,memory_verse=$9,is_current=$10 WHERE id=$11 RETURNING *
    `, [quarter, year || 2026, theme_title, theme_sub || null, book || null, book_full || null, lesson_count || 13, period || null, memory_verse || null, is_current || false, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Quarter not found.' });
    await saveQuarterTranslations(req.params.id, translations);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/quarter-info/:id/set-current', adminAuth, async (req, res) => {
  try {
    await db.query('UPDATE quarter_info SET is_current=FALSE');
    await db.query('UPDATE quarter_info SET is_current=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/admin/quarter-info/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM quarter_info WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad banners ─────────────────────────────────────────────────────────────
router.get('/api/banners/active', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id,title,image_base64,image_url,link_url,expires_at FROM ad_banners
      WHERE is_active=TRUE
        AND (scheduled_at IS NULL OR scheduled_at<=NOW())
        AND (expires_at IS NULL OR expires_at>NOW())
      ORDER BY created_at DESC LIMIT 1
    `);
    res.json({ banner: r.rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id,title,image_url,image_base64,is_active,scheduled_at,expires_at,created_at FROM ad_banners ORDER BY created_at DESC'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/banners', adminAuth, async (req, res) => {
  const { title, image_base64, image_url, link_url, is_active, scheduled_at, expires_at } = req.body;
  try {
    const r = await db.query(
      `INSERT INTO ad_banners (title,image_base64,image_url,link_url,is_active,scheduled_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title || null, image_base64 || null, image_url || null, link_url || null, is_active || false, scheduled_at || null, expires_at || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/admin/banners/:id', adminAuth, async (req, res) => {
  const { title, image_base64, image_url, link_url, is_active, scheduled_at, expires_at } = req.body;
  try {
    if (is_active) await db.query('UPDATE ad_banners SET is_active=FALSE WHERE id!=$1', [req.params.id]);
    const r = await db.query(
      `UPDATE ad_banners SET title=$1,image_base64=$2,image_url=$3,link_url=$4,is_active=$5,
       scheduled_at=$6,expires_at=$7,updated_at=NOW() WHERE id=$8 RETURNING *`,
      [title || null, image_base64 || null, image_url || null, link_url || null, is_active || false, scheduled_at || null, expires_at || null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try { await db.query('DELETE FROM ad_banners WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bible verses ───────────────────────────────────────────────────────────
router.get('/api/bible-verse/:reference', async (req, res) => {
  try {
    const ref = decodeURIComponent(req.params.reference);
    const r   = await db.query('SELECT text,version FROM bible_verses WHERE LOWER(reference)=LOWER($1)', [ref]);
    if (r.rows.length) return res.json({ reference: ref, text: r.rows[0].text, version: r.rows[0].version, source: 'db' });
    res.json({ reference: ref, text: null, source: 'not_found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/admin/bible-verses', adminAuth, async (req, res) => {
  try { res.json((await db.query('SELECT * FROM bible_verses ORDER BY created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/admin/bible-verses', adminAuth, async (req, res) => {
  const { reference, text, version } = req.body;
  if (!reference || !text) return res.status(400).json({ error: 'Reference and text required' });
  try {
    const r = await db.query(
      `INSERT INTO bible_verses (reference,text,version) VALUES ($1,$2,$3)
       ON CONFLICT (reference) DO UPDATE SET text=$2, version=$3, created_at=NOW() RETURNING *`,
      [reference.trim(), text.trim(), version || 'KJV']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/admin/bible-verses/:id', adminAuth, async (req, res) => {
  try { await db.query('DELETE FROM bible_verses WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
