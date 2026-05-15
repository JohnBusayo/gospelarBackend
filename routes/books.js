// routes/books.js
// Library catalogue + per-book daily entries. Public reads (no auth) match
// the trust model of /api/lessons; admin writes are adminAuth-gated.
//
// Two book shapes coexist:
//   route_screen='HomeScreen'  — Sunday School (uses categories/units/lessons)
//   route_screen='BookReader'  — generic per-day book reader (book_entries)

const express = require('express');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/api/books', async (req, res) => {
  const includeUnavailable = req.query.include === 'unavailable';
  try {
    const r = await db.query(`
      SELECT id, slug, title, subtitle, description, cover_image_url, cover_emoji,
             accent_color, route_screen, available, sort_order, language,
             translations, created_at, updated_at,
             (SELECT COUNT(*) FROM book_entries WHERE book_id = books.id) AS entries_count
        FROM books
       ${includeUnavailable ? '' : 'WHERE available = TRUE'}
       ORDER BY sort_order ASC, id ASC
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/books:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load books.' });
  }
});

router.get('/api/books/:slug', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, slug, title, subtitle, description, cover_image_url, cover_emoji,
             accent_color, route_screen, available, sort_order, language,
             created_at, updated_at
        FROM books WHERE slug = $1
    `, [req.params.slug]);
    if (!r.rows.length) return res.status(404).json({ error: 'Book not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('GET /api/books/:slug:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load book.' });
  }
});

// Lightweight list for the day-selector — no long-form fields.
router.get('/api/books/:slug/entries', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT e.id, e.entry_number, e.entry_type, e.entry_date, e.focus, e.scripture_text, e.sort_order
        FROM book_entries e
        JOIN books b ON b.id = e.book_id
       WHERE b.slug = $1
       ORDER BY e.entry_type, e.entry_number
    `, [req.params.slug]);
    res.json({ slug: req.params.slug, count: r.rows.length, entries: r.rows });
  } catch (e) {
    console.error('GET /api/books/:slug/entries:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load entries.' });
  }
});

// Defaults type to 'daily'; pass ?type=family_vigil etc. for vigil sessions.
router.get('/api/books/:slug/entries/:number', async (req, res) => {
  const number = parseInt(req.params.number, 10);
  const type   = String(req.query.type || 'daily');
  if (!Number.isFinite(number)) return res.status(400).json({ error: 'Invalid entry number.' });
  try {
    const r = await db.query(`
      SELECT e.*
        FROM book_entries e
        JOIN books b ON b.id = e.book_id
       WHERE b.slug = $1 AND e.entry_number = $2 AND e.entry_type = $3
    `, [req.params.slug, number, type]);
    if (!r.rows.length) return res.status(404).json({ error: 'Entry not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('GET /api/books/:slug/entries/:number:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load entry.' });
  }
});

router.post('/api/admin/books', adminAuth, async (req, res) => {
  const {
    slug, title, subtitle, description, cover_image_url, cover_emoji,
    accent_color, route_screen, available, sort_order, language,
  } = req.body || {};
  if (!slug || !title) return res.status(400).json({ error: 'slug and title are required.' });
  try {
    const r = await db.query(`
      INSERT INTO books (slug, title, subtitle, description, cover_image_url, cover_emoji,
                         accent_color, route_screen, available, sort_order, language)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      String(slug).trim().toLowerCase(),
      title.trim(),
      (subtitle || '').trim() || null,
      (description || '').trim() || null,
      (cover_image_url || '').trim() || null,
      (cover_emoji || '📖').slice(0, 10),
      (accent_color || '#1A56DB').slice(0, 20),
      (route_screen || 'BookReader').slice(0, 40),
      available !== false,
      Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 100,
      (language || 'en').slice(0, 10),
    ]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A book with that slug already exists.' });
    console.error('POST /api/admin/books:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create book.' });
  }
});

router.put('/api/admin/books/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  // Whitelist updatable columns and build a dynamic SET clause so unknown
  // fields can't sneak in. updated_at always bumped.
  const allowed = [
    'title', 'subtitle', 'description', 'cover_image_url', 'cover_emoji',
    'accent_color', 'route_screen', 'available', 'sort_order', 'language',
    'translations',
  ];
  const sets   = ['updated_at = NOW()'];
  const params = [];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
      if (k === 'translations') {
        params.push(JSON.stringify(req.body[k] || {}));
        sets.push(`${k} = $${params.length}::jsonb`);
      } else {
        params.push(req.body[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }
  }
  if (params.length === 0) return res.status(400).json({ error: 'No updatable fields supplied.' });
  params.push(id);
  try {
    const r = await db.query(
      `UPDATE books SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Book not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/books/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update book.' });
  }
});

// Same INSERT … ON CONFLICT used by the seed endpoint — handles both create
// (new entry_number) and edit (existing one) idempotently.
router.post('/api/admin/books/:id/entries', adminAuth, async (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  if (!Number.isFinite(bookId)) return res.status(400).json({ error: 'Invalid book id.' });
  const {
    entry_number, entry_type = 'daily', entry_date,
    focus, scripture_text, inspirational_message,
    prayer_points, special_intercession, hymn,
    discussion_questions, declarations, sort_order,
    translations,
  } = req.body || {};
  if (!Number.isFinite(parseInt(entry_number, 10))) {
    return res.status(400).json({ error: 'entry_number required.' });
  }
  try {
    const r = await db.query(`
      INSERT INTO book_entries (
        book_id, entry_number, entry_type, entry_date,
        focus, scripture_text, inspirational_message,
        prayer_points, special_intercession, hymn,
        discussion_questions, declarations, sort_order, translations
      )
      VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14::jsonb)
      ON CONFLICT (book_id, entry_number, entry_type) DO UPDATE SET
        entry_date            = EXCLUDED.entry_date,
        focus                 = EXCLUDED.focus,
        scripture_text        = EXCLUDED.scripture_text,
        inspirational_message = EXCLUDED.inspirational_message,
        prayer_points         = EXCLUDED.prayer_points,
        special_intercession  = EXCLUDED.special_intercession,
        hymn                  = EXCLUDED.hymn,
        discussion_questions  = EXCLUDED.discussion_questions,
        declarations          = EXCLUDED.declarations,
        sort_order            = EXCLUDED.sort_order,
        translations          = EXCLUDED.translations
      RETURNING *
    `, [
      bookId,
      parseInt(entry_number, 10),
      String(entry_type),
      entry_date || null,
      focus || null,
      scripture_text || null,
      inspirational_message || null,
      JSON.stringify(prayer_points || []),
      special_intercession || null,
      hymn ? JSON.stringify(hymn) : null,
      discussion_questions ? JSON.stringify(discussion_questions) : null,
      declarations ? JSON.stringify(declarations) : null,
      Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 100,
      JSON.stringify(translations || {}),
    ]);
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Book not found.' });
    console.error('POST /api/admin/books/:id/entries:', e.code, e.message);
    res.status(500).json({ error: 'Failed to upsert entry.' });
  }
});

// Bulk seed inside a transaction — one POST replaces a loop of 36 individual
// upserts the admin would otherwise do to import the bundled Victory Month
// content the first time. Wrapper falls back to non-transactional if our
// db wrapper doesn't expose .connect() (most builds don't).
router.post('/api/admin/books/:slug/seed', adminAuth, async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const { meta, entries } = req.body || {};
  if (!slug)                  return res.status(400).json({ error: 'slug is required.' });
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries[] is required.' });

  const client = await db.connect ? await db.connect() : null;
  // Fall back to non-transactional mode when no client is available — the
  // upserts are still idempotent per row, so the worst case is a partial
  // success the admin can retry.
  const q = client ? client.query.bind(client) : db.query.bind(db);

  try {
    if (client) await q('BEGIN');

    const bookResult = await q(
      `SELECT id FROM books WHERE slug = $1`,
      [slug]
    );
    if (!bookResult.rows.length) {
      if (client) await q('ROLLBACK');
      return res.status(404).json({ error: 'Book not found. Create it first.' });
    }
    const bookId = bookResult.rows[0].id;

    if (meta && typeof meta === 'object') {
      const allowed = [
        'title', 'subtitle', 'description', 'cover_image_url', 'cover_emoji',
        'accent_color', 'route_screen', 'available', 'sort_order', 'language',
        'translations',
      ];
      const sets = ['updated_at = NOW()'];
      const params = [];
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(meta, k)) {
          if (k === 'translations') {
            params.push(JSON.stringify(meta[k] || {}));
            sets.push(`${k} = $${params.length}::jsonb`);
          } else {
            params.push(meta[k]);
            sets.push(`${k} = $${params.length}`);
          }
        }
      }
      if (params.length) {
        params.push(bookId);
        await q(`UPDATE books SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
    }

    let upserted = 0;
    for (const e of entries) {
      if (!Number.isFinite(parseInt(e.entry_number, 10))) continue;
      await q(`
        INSERT INTO book_entries (
          book_id, entry_number, entry_type, entry_date,
          focus, scripture_text, inspirational_message,
          prayer_points, special_intercession, hymn,
          discussion_questions, declarations, sort_order, translations
        )
        VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14::jsonb)
        ON CONFLICT (book_id, entry_number, entry_type) DO UPDATE SET
          entry_date            = EXCLUDED.entry_date,
          focus                 = EXCLUDED.focus,
          scripture_text        = EXCLUDED.scripture_text,
          inspirational_message = EXCLUDED.inspirational_message,
          prayer_points         = EXCLUDED.prayer_points,
          special_intercession  = EXCLUDED.special_intercession,
          hymn                  = EXCLUDED.hymn,
          discussion_questions  = EXCLUDED.discussion_questions,
          declarations          = EXCLUDED.declarations,
          sort_order            = EXCLUDED.sort_order,
          translations          = EXCLUDED.translations
      `, [
        bookId,
        parseInt(e.entry_number, 10),
        String(e.entry_type || 'daily'),
        e.entry_date || null,
        e.focus || null,
        e.scripture_text || null,
        e.inspirational_message || null,
        JSON.stringify(e.prayer_points || []),
        e.special_intercession || null,
        e.hymn ? JSON.stringify(e.hymn) : null,
        e.discussion_questions ? JSON.stringify(e.discussion_questions) : null,
        e.declarations ? JSON.stringify(e.declarations) : null,
        Number.isFinite(parseInt(e.sort_order, 10)) ? parseInt(e.sort_order, 10) : 100,
        JSON.stringify(e.translations || {}),
      ]);
      upserted++;
    }

    if (client) await q('COMMIT');
    res.json({ ok: true, slug, book_id: bookId, upserted, received: entries.length });
  } catch (e) {
    if (client) { try { await q('ROLLBACK'); } catch {} }
    console.error('POST /api/admin/books/:slug/seed:', e.code, e.message);
    res.status(500).json({ error: 'Failed to seed entries.' });
  } finally {
    if (client?.release) try { client.release(); } catch {}
  }
});

router.delete('/api/admin/books/:id/entries/:number', adminAuth, async (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  const number = parseInt(req.params.number, 10);
  const type   = String(req.query.type || 'daily');
  if (!Number.isFinite(bookId) || !Number.isFinite(number)) {
    return res.status(400).json({ error: 'Invalid id or entry number.' });
  }
  try {
    const r = await db.query(
      'DELETE FROM book_entries WHERE book_id = $1 AND entry_number = $2 AND entry_type = $3 RETURNING id',
      [bookId, number, type]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ ok: true, deleted: r.rows[0].id });
  } catch (e) {
    console.error('DELETE /api/admin/books/:id/entries:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete entry.' });
  }
});

module.exports = router;
