// scripts/rename-victory-slug.js
// ─────────────────────────────────────────────────────────────────────────────
// One-shot rename: the Victory Month Prayer book's `books.slug` was
// `victory-month-2026` (or, post-merge, `victory-month-prayer`). The rest of
// the codebase — subscribed_books, plan_id (book_victory_month_prayer),
// BookGuard, the local frontend BOOKS array — uses `victory_month_prayer`
// with underscores. That slug drift is what let Sunday-School subscribers
// see Victory Month as "Available" in LibraryScreen until normalizeBook
// was made fail-closed.
//
// This script aligns the database with the rest of the system so there's
// one canonical slug everywhere going forward.
//
// Idempotent. Safe to run repeatedly.
//   • If a row already has slug='victory_month_prayer' → reports "already
//     canonical" and exits clean.
//   • If the legacy slug ('victory-month-2026' or 'victory-month-prayer')
//     exists → UPDATE to the canonical form.
//   • If neither exists → reports "no victory book row found" and exits.
//
// Usage:
//   cd backend && node scripts/rename-victory-slug.js
//
// Dry run (prints what it would do, makes no changes):
//   cd backend && node scripts/rename-victory-slug.js --dry-run
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db');

const CANONICAL_SLUG = 'victory_month_prayer';
const LEGACY_SLUGS   = ['victory-month-2026', 'victory-month-prayer'];
const DRY_RUN        = process.argv.includes('--dry-run');

async function main() {
  console.log(DRY_RUN ? '🟡 DRY RUN — no changes will be written\n' : '');

  const existing = await db.query(
    `SELECT id, slug, title,
            (SELECT COUNT(*) FROM book_entries WHERE book_id = books.id) AS entries
       FROM books
      WHERE slug = ANY($1::text[])
      ORDER BY entries DESC, id ASC`,
    [[CANONICAL_SLUG, ...LEGACY_SLUGS]],
  );

  if (!existing.rows.length) {
    console.log('ℹ️  No Victory Month row found in `books`. Nothing to rename.');
    return;
  }

  const already = existing.rows.find((r) => r.slug === CANONICAL_SLUG);
  if (already) {
    console.log(`✅ Already canonical — row #${already.id} (${already.entries} entries) has slug '${CANONICAL_SLUG}'.`);
    return;
  }

  const target = existing.rows[0];
  console.log(
    `→ Renaming row #${target.id} (${target.entries} entries) ` +
    `from '${target.slug}' → '${CANONICAL_SLUG}'`,
  );

  if (DRY_RUN) {
    console.log('   (dry-run, skipping UPDATE)');
    return;
  }

  // Defensive: if BOTH slugs somehow ended up in the table at once, the
  // UNIQUE constraint on books.slug will block the UPDATE. Delete the
  // empty canonical row first if it exists with no entries.
  const collision = await db.query(
    `SELECT id, (SELECT COUNT(*) FROM book_entries WHERE book_id = books.id) AS entries
       FROM books WHERE slug = $1`,
    [CANONICAL_SLUG],
  );
  if (collision.rows.length && Number(collision.rows[0].entries) === 0) {
    console.log(`   removing empty canonical placeholder row #${collision.rows[0].id}`);
    await db.query('DELETE FROM books WHERE id = $1', [collision.rows[0].id]);
  }

  await db.query(
    `UPDATE books SET slug = $1, updated_at = NOW() WHERE id = $2`,
    [CANONICAL_SLUG, target.id],
  );

  console.log(`✅ Renamed. New slug: '${CANONICAL_SLUG}'.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ rename-victory-slug failed:', e.code || '(no code)', e.message);
    process.exit(1);
  });
