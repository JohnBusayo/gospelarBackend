// routes/content.js
// Categories, languages, UI translations, category↔language mapping. Public
// reads + admin writes. The /seed and /import-from-source endpoints rebuild
// the translations table from the bundled ui_translations.js source.

const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');
const { KEYS: UI_SEED_KEYS, EN: UI_SEED_EN } = require('../data/uiSeedKeys');

const router = express.Router();

// ── Categories ──────────────────────────────────────────────────────────────
router.get('/api/categories', async (req, res) => {
  const lang = req.query.lang || 'en';
  try {
    const r = await db.query(`
      SELECT c.id, c.color, c.icon, c.sort_order,
        COALESCE(ct.label,       c.label)       AS label,
        COALESCE(ct.description, c.description) AS description
      FROM categories c
      LEFT JOIN category_translations ct ON ct.category_id=c.id AND ct.lang_code=$1
      ORDER BY c.sort_order
    `, [lang]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch categories.' }); }
});

router.post('/api/admin/categories', adminAuth, async (req, res) => {
  const { id, label, description, color, icon, sort_order } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id and label required.' });
  try {
    const r = await db.query(
      `INSERT INTO categories (id,label,description,color,icon,sort_order) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description,
         color=EXCLUDED.color, icon=EXCLUDED.icon, sort_order=EXCLUDED.sort_order RETURNING *`,
      [id, label, description || null, color || '#2563EB', icon || '📖', sort_order || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to save category.' }); }
});

router.post('/api/admin/category-translations', adminAuth, async (req, res) => {
  const { category_id, lang_code, label, description } = req.body;
  if (!category_id || !lang_code) return res.status(400).json({ error: 'category_id and lang_code required.' });
  try {
    await db.query(`
      INSERT INTO category_translations (category_id,lang_code,label,description)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (category_id,lang_code) DO UPDATE
        SET label=EXCLUDED.label, description=EXCLUDED.description, updated_at=NOW()
    `, [category_id, lang_code, label || null, description || null]);
    res.json({ message: `Saved [${lang_code}] for category ${category_id}` });
  } catch (e) { res.status(500).json({ error: 'Failed to save category translation.' }); }
});

// ── Languages & translations ────────────────────────────────────────────────
router.get('/api/languages', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT code,label,native_label,flag FROM languages WHERE is_active=TRUE ORDER BY label'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch languages.' }); }
});

router.get('/api/translations/:langCode', async (req, res) => {
  const { langCode } = req.params;
  try {
    const lc   = await db.query('SELECT code FROM languages WHERE code=$1 AND is_active=TRUE', [langCode]);
    const lang = lc.rows.length ? langCode : 'en';
    const r    = await db.query('SELECT key,value FROM translations WHERE lang_code=$1', [lang]);
    const translations = {};
    r.rows.forEach((row) => { translations[row.key] = row.value; });
    res.json({ lang, translations, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch translations.' }); }
});

router.put('/api/translations', adminAuth, async (req, res) => {
  const { langCode, key, value } = req.body;
  if (!langCode || !key || value === undefined) return res.status(400).json({ error: 'langCode, key, value required.' });
  try {
    await db.query(
      `INSERT INTO translations (lang_code,key,value) VALUES ($1,$2,$3)
       ON CONFLICT (lang_code,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [langCode, key, value]
    );
    res.json({ message: `Updated [${langCode}] ${key}` });
  } catch (e) { res.status(500).json({ error: 'Failed to update translation.' }); }
});

// Seed all UI translation key placeholders (English defaults; other langs blank).
// One-shot bootstrap — use /import-from-source afterwards to push real
// translated values from ui_translations.js. The full key/EN payload lives
// in data/uiSeedKeys.js so this route file stays scannable.
router.post('/api/admin/translations/seed', adminAuth, async (req, res) => {
  try {
    for (const key of UI_SEED_KEYS) {
      await db.query(
        `INSERT INTO translations (lang_code,key,value) VALUES ('en',$1,$2)
         ON CONFLICT (lang_code,key) DO NOTHING`, [key, UI_SEED_EN[key] || key]
      );
    }
    for (const lang of ['yo', 'ig', 'ha']) {
      for (const key of UI_SEED_KEYS) {
        await db.query(
          `INSERT INTO translations (lang_code,key,value) VALUES ($1,$2,'')
           ON CONFLICT (lang_code,key) DO NOTHING`, [lang, key]
        );
      }
    }
    res.json({ message: `Seeded ${UI_SEED_KEYS.length} keys for en/yo/ig/ha`, keys: UI_SEED_KEYS.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk import every translation row from backend/ui_translations.js — UPSERTs
// values, so re-running it overwrites with the latest source-of-truth strings.
// Chunked to keep us under Postgres' 65,535 parameter limit and to dodge the
// timeout the previous one-await-per-row implementation hit on Railway's pooler.
router.post('/api/admin/translations/import-from-source', adminAuth, async (req, res) => {
  try {
    // Lazy-require so the route file doesn't fail to load if the module is
    // momentarily missing during a deploy hot-swap.
    const { UI_TRANSLATIONS } = require('../ui_translations');

    const rows = UI_TRANSLATIONS.filter((tr) => tr.val != null && tr.val !== '');
    const skipped = UI_TRANSLATIONS.length - rows.length;

    if (rows.length === 0) {
      return res.json({ message: 'No rows to import.', total: UI_TRANSLATIONS.length, written: 0, skipped });
    }

    const CHUNK = 500;
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice  = rows.slice(i, i + CHUNK);
      const params = [];
      const values = slice.map((tr, idx) => {
        const o = idx * 3;
        params.push(tr.lang_code, tr.key, tr.val);
        return `($${o + 1}, $${o + 2}, $${o + 3})`;
      }).join(', ');
      await db.query(
        `INSERT INTO translations (lang_code, key, value)
         VALUES ${values}
         ON CONFLICT (lang_code, key) DO UPDATE SET value = EXCLUDED.value`,
        params
      );
      written += slice.length;
    }

    res.json({
      message: `Imported ${written} translation rows from ui_translations.js`,
      total:   UI_TRANSLATIONS.length,
      written,
      skipped,
    });
  } catch (e) {
    console.error('admin/translations/import-from-source:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/category-language/:categoryId', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT lang_code FROM category_languages WHERE category_id=$1', [req.params.categoryId]
    );
    res.json({ categoryId: req.params.categoryId, langCode: r.rows[0]?.lang_code || 'en' });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch category language.' }); }
});

module.exports = router;
