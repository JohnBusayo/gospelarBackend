// routes/profile.js
// User profile (display name, avatar, prefs) + hymns. Both unauthenticated
// reads + admin writes for hymn management; profile uses email-keyed access
// matching the rest of the read API's trust model.

const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/api/profile/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const r = await db.query('SELECT * FROM user_profiles WHERE email=$1', [email]);
    res.json(r.rows[0] || { email });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch profile.' }); }
});

router.put('/api/profile/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { display_name, avatar_emoji, church, location, lang_pref, dark_mode, notifications } = req.body;
  try {
    const r = await db.query(`
      INSERT INTO user_profiles (email,display_name,avatar_emoji,church,location,lang_pref,dark_mode,notifications)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (email) DO UPDATE SET
        display_name  = COALESCE(EXCLUDED.display_name,  user_profiles.display_name),
        avatar_emoji  = COALESCE(EXCLUDED.avatar_emoji,  user_profiles.avatar_emoji),
        church        = COALESCE(EXCLUDED.church,        user_profiles.church),
        location      = COALESCE(EXCLUDED.location,      user_profiles.location),
        lang_pref     = COALESCE(EXCLUDED.lang_pref,     user_profiles.lang_pref),
        dark_mode     = COALESCE(EXCLUDED.dark_mode,     user_profiles.dark_mode),
        notifications = COALESCE(EXCLUDED.notifications, user_profiles.notifications),
        updated_at    = NOW()
      RETURNING *
    `, [
      email, display_name || null, avatar_emoji || null, church || null, location || null,
      lang_pref || null, dark_mode !== undefined ? dark_mode : null, notifications !== undefined ? notifications : null,
    ]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to update profile.' }); }
});

// ── Hymns ──────────────────────────────────────────────────────────────────
router.get('/api/hymns/:number', async (req, res) => {
  const n = parseInt(req.params.number, 10);
  if (isNaN(n)) return res.status(400).json({ error: 'Invalid hymn number.' });
  try {
    const r = await db.query('SELECT * FROM hymns WHERE number=$1', [n]);
    if (!r.rows.length) return res.status(404).json({ error: `Hymn #${n} not found.` });
    const h = r.rows[0];
    res.json({ id: h.id, number: h.number, title: h.title, author: h.author || null, chorus: h.chorus || null, verses: h.verses || [] });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch hymn.' }); }
});

router.get('/api/hymns', async (req, res) => {
  const numbers = (req.query.numbers || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
  if (!numbers.length) return res.status(400).json({ error: 'Provide ?numbers=290,480' });
  try {
    const ph = numbers.map((_, i) => `$${i + 1}`).join(',');
    const r  = await db.query(`SELECT * FROM hymns WHERE number IN (${ph}) ORDER BY number`, numbers);
    const byNum = Object.fromEntries(r.rows.map((h) => [h.number, h]));
    res.json(numbers.map((n) => byNum[n] || null).filter(Boolean));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch hymns.' }); }
});

router.get('/api/admin/hymns', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id,number,title,author, chorus IS NOT NULL AS has_chorus, jsonb_array_length(verses) AS verse_count FROM hymns ORDER BY number'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch hymns.' }); }
});

router.post('/api/admin/hymns', adminAuth, async (req, res) => {
  const { number, title, author, chorus, verses } = req.body;
  if (!number || !title || !Array.isArray(verses)) return res.status(400).json({ error: 'number, title, verses[] required.' });
  try {
    const r = await db.query(
      `INSERT INTO hymns (number,title,author,chorus,verses) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (number) DO UPDATE SET title=EXCLUDED.title, author=EXCLUDED.author,
         chorus=EXCLUDED.chorus, verses=EXCLUDED.verses RETURNING *`,
      [number, title, author || null, chorus || null, JSON.stringify(verses)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to save hymn.' }); }
});

router.delete('/api/admin/hymns/:number', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM hymns WHERE number=$1 RETURNING id', [parseInt(req.params.number, 10)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Hymn not found.' });
    res.json({ message: `Hymn #${req.params.number} deleted.` });
  } catch (e) { res.status(500).json({ error: 'Failed to delete hymn.' }); }
});

module.exports = router;
