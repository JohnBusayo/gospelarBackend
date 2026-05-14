// scripts/merge-victory-books.js
// ─────────────────────────────────────────────────────────────────────────────
// One-shot merge for the two Victory Month rows the dashboard currently
// shows in /books.
//
// The mess:
//   • "Victory Month Prayer Bulletin 2026"  · slug = victory-month-2026   · 37 entries (REAL content)
//   • "Victory Month Prayer"                · slug = victory-month-prayer · 0 entries  (empty placeholder
//                                                                                       from the inline initDb seed)
//
// The fix:
//   1. DELETE the empty `victory-month-prayer` row
//   2. UPDATE the content row: SET slug = 'victory-month-prayer'
//
// After this, the surviving book is the one with all 37 entries, titled
// "Victory Month Prayer Bulletin 2026", reachable via the canonical slug
// the dashboard (maindashboard/.../victoryData.js), mobile app
// (frontend/services/victory.js), and seed script all already use.
//
// Idempotent. Safe to run a second time — if there's only one book left,
// it reports "already merged" and exits clean.
//
// Usage:
//   cd backend && node scripts/merge-victory-books.js
//
// Optional dry run (prints what it would do, makes no changes):
//   cd backend && node scripts/merge-victory-books.js --dry-run
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db');

// Canonical is the bulletin row that actually has content; legacy is the
// empty placeholder seeded by the old initDb inline INSERT.
const CANONICAL_SLUG = 'victory-month-2026';
const LEGACY_SLUG    = 'victory-month-prayer';
const DRY_RUN        = process.argv.includes('--dry-run');

async function main() {
  // Find the two candidate rows (if they exist).
  const r = await db.query(
    `SELECT b.id, b.slug, b.title, b.cover_emoji, b.updated_at,
            (SELECT COUNT(*)::int FROM book_entries WHERE book_id = b.id) AS entries_count
       FROM books b
      WHERE b.slug IN ($1, $2)`,
    [CANONICAL_SLUG, LEGACY_SLUG],
  );

  const canonical = r.rows.find((x) => x.slug === CANONICAL_SLUG) || null;
  const legacy    = r.rows.find((x) => x.slug === LEGACY_SLUG)    || null;

  console.log('[merge] current state:');
  console.log(`  canonical (${CANONICAL_SLUG}):`, canonical
    ? `id=${canonical.id} · title="${canonical.title}" · entries=${canonical.entries_count}`
    : 'absent');
  console.log(`  legacy    (${LEGACY_SLUG}):`,    legacy
    ? `id=${legacy.id} · title="${legacy.title}" · entries=${legacy.entries_count}`
    : 'absent');
  console.log('');

  // ── Already in the desired state ────────────────────────────────────────
  if (canonical && !legacy) {
    console.log('[merge] only the canonical book exists — already merged. Nothing to do.');
    process.exit(0);
  }

  // ── The legacy book exists but the canonical doesn't — just re-slug ─────
  if (legacy && !canonical) {
    console.log(`[merge] legacy book has content; canonical absent → re-slug to ${CANONICAL_SLUG}`);
    if (DRY_RUN) { console.log('[merge] DRY RUN — no changes.'); process.exit(0); }
    await db.query(`UPDATE books SET slug = $1, updated_at = NOW() WHERE id = $2`, [CANONICAL_SLUG, legacy.id]);
    console.log('[merge] done.');
    process.exit(0);
  }

  // ── Both exist — the interesting case ──────────────────────────────────
  if (canonical && legacy) {
    // SAFETY: refuse to drop a row that has entries. We expect the canonical
    // to be the empty placeholder; if it's not, the operator should run with
    // --dry-run first and decide manually.
    if (canonical.entries_count > 0 && legacy.entries_count > 0) {
      console.error(`[merge] REFUSING TO RUN — both rows have entries:`);
      console.error(`  canonical: ${canonical.entries_count} entries`);
      console.error(`  legacy:    ${legacy.entries_count} entries`);
      console.error('Inspect both books in the dashboard and decide which to keep.');
      console.error('Then either DELETE the unwanted one manually or rerun this script after the deletion.');
      process.exit(1);
    }

    // Decide which is the "keeper". By the user's report, the legacy holds
    // the real content; the canonical is the empty placeholder. But guard
    // against the opposite case explicitly: keep whichever has more entries.
    const keeper = (legacy.entries_count >= canonical.entries_count) ? legacy : canonical;
    const drop   = keeper === legacy ? canonical : legacy;

    console.log(`[merge] keeping book id=${keeper.id} (slug=${keeper.slug}, ${keeper.entries_count} entries)`);
    console.log(`[merge] dropping book id=${drop.id} (slug=${drop.slug}, ${drop.entries_count} entries)`);

    if (DRY_RUN) { console.log('[merge] DRY RUN — no changes.'); process.exit(0); }

    // ── Step 1: drop the empty one (CASCADE drops its 0 entries — no-op). ─
    await db.query(`DELETE FROM books WHERE id = $1`, [drop.id]);

    // ── Step 2: re-slug the keeper to the canonical slug if needed. ──────
    if (keeper.slug !== CANONICAL_SLUG) {
      await db.query(
        `UPDATE books SET slug = $1, updated_at = NOW() WHERE id = $2`,
        [CANONICAL_SLUG, keeper.id],
      );
      console.log(`[merge] re-slugged keeper → ${CANONICAL_SLUG}`);
    }

    console.log(`[merge] done. Single surviving book: "${keeper.title}" (slug=${CANONICAL_SLUG}, id=${keeper.id}).`);
    process.exit(0);
  }

  // ── Neither row exists — nothing to merge ──────────────────────────────
  console.log('[merge] neither row found. Run the seed first (node scripts/seed-victory-month.js).');
  process.exit(0);
}

main().catch((err) => {
  console.error('[merge] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
