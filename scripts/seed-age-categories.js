// backend/scripts/seed-age-categories.js
// ─────────────────────────────────────────────────────────────────────────────
// Seeds 13 age-adapted lessons each for the YOUTH, INTERMEDIATE and CHILDREN
// categories of the Q4 2026 quarter ("Demonstration of the Christian Life" —
// the Philemon series). Mirrors the adult curriculum lesson-by-lesson, but
// every lesson's prose is rewritten for the target age group:
//
//   • Youth        (18–25) — peer relationships, identity, faith integration,
//                            early career and campus life.
//   • Intermediate (12–17) — friendships, family, growing in faith, school
//                            and youth-fellowship situations.
//   • Children     (4–11)  — short paragraphs, simple vocabulary, Jesus-
//                            centred stories drawn from everyday childhood
//                            experiences (sharing, helping, saying sorry).
//
// Run:
//   node scripts/seed-age-categories.js
//
// Idempotent: deletes any existing lessons attached to the youth_unit_*,
// intermediate_unit_* and children_unit_* unit IDs (cascading their
// lesson_translations) before re-inserting. Adult lessons are untouched.
// ─────────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg');
require('dotenv').config();

const { YOUTH_LESSONS }        = require('./data/youth-lessons');
const { INTERMEDIATE_LESSONS } = require('./data/intermediate-lessons');
const { CHILDREN_LESSONS }     = require('./data/children-lessons');

// Reuses the same connection-string / env-var pattern as backend/seed.js.
const db = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        user:     process.env.DB_USER     || process.env.PGUSER     || 'postgres',
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD || '',
        host:     process.env.DB_HOST     || process.env.PGHOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
        database: process.env.DB_NAME     || process.env.PGDATABASE || 'gospeler',
      }
);

const run  = (sql, params = []) => db.query(sql, params);
const log  = (msg) => console.log(`  ✓  ${msg}`);
const warn = (msg) => console.warn(`  ⚠  ${msg}`);
const safe = (val, max = 198) => (val || '').toString().substring(0, max);

// Shared metadata — same date, hymn, devotional-reading and quarter theme as
// the matching adult lesson so the four age groups stay in sync week-to-week.
const SHARED = [
  { n: 1,  date: '4th October, 2026',  reading: 'Acts 10:34–48',           hymns: 'MHB 720, MHB 481, MHB 503' },
  { n: 2,  date: '11th October, 2026', reading: '1 Corinthians 13:1–13',   hymns: 'MHB 416, MHB 395, MHB 539' },
  { n: 3,  date: '18th October, 2026', reading: '1 Corinthians 6:9–11',    hymns: 'MHB 290, MHB 362, MHB 441' },
  { n: 4,  date: '25th October, 2026', reading: 'Galatians 3:26–4:7',      hymns: 'MHB 216, MHB 465, MHB 528' },
  { n: 5,  date: '1st November, 2026', reading: 'Matthew 18:21–35',        hymns: 'MHB 362, MHB 294, MHB 512' },
  { n: 6,  date: '8th November, 2026', reading: '2 Corinthians 5:17–21',   hymns: 'MHB 503, MHB 467, MHB 291' },
  { n: 7,  date: '15th November, 2026', reading: 'Romans 12:9–21',         hymns: 'MHB 395, MHB 719, MHB 480' },
  { n: 8,  date: '22nd November, 2026', reading: 'Hebrews 7:23–27',        hymns: 'MHB 530, MHB 427, MHB 441' },
  { n: 9,  date: '29th November, 2026', reading: 'Daniel 3:13–18',         hymns: 'MHB 480, MHB 395, MHB 539' },
  { n: 10, date: '6th December, 2026',  reading: 'Colossians 3:22–4:1',    hymns: 'MHB 465, MHB 719, MHB 395' },
  { n: 11, date: '13th December, 2026', reading: 'Ephesians 5:22–6:4',     hymns: 'MHB 721, MHB 467, MHB 480' },
  { n: 12, date: '20th December, 2026', reading: 'Luke 10:25–37',          hymns: 'MHB 395, MHB 480, MHB 503' },
  { n: 13, date: '27th December, 2026', reading: 'Titus 2:11–14',          hymns: 'MHB 762, MHB 395, MHB 528' },
];
const QUARTER_THEME = 'Demonstration of the Christian Life';

// Lesson number → unit number (1, 2, or 3) — same split the adult curriculum
// uses: 1–4 in unit 1, 5–9 in unit 2, 10–13 in unit 3.
const unitForLesson = (n) => {
  if (n <= 4)  return 1;
  if (n <= 9)  return 2;
  return 3;
};

// Shape the per-category JS object into the row payload the lessons +
// lesson_translations tables expect. Pulls shared metadata (date, hymns,
// reading, quarter theme) from SHARED so every age-group row stays
// week-aligned with the adult lessons.
function toRow(category, lesson) {
  const shared = SHARED.find((s) => s.n === lesson.n);
  if (!shared) throw new Error(`No SHARED entry for lesson ${lesson.n}`);
  return {
    category_id:           category,
    unit_id:               `${category}_unit_${unitForLesson(lesson.n)}`,
    lesson_number:         lesson.n,
    title:                 lesson.title,
    topic:                 lesson.topic,
    lesson_date:           shared.date,
    quarter_theme:         QUARTER_THEME,
    suggested_hymns:       shared.hymns,
    devotional_reading:    shared.reading,
    memory_verse:          lesson.memory_verse,
    memory_verse_passage:  lesson.memory_verse_passage,
    lesson_background:     lesson.background,
    lesson_conclusion:     lesson.conclusion,
    // Reshape part keys to match the existing schema convention
    // (part_topic / part_para1 / part_para2).
    lesson_part: (lesson.parts || []).map((p) => ({
      part_topic: p.topic,
      part_para1: p.para1,
      part_para2: p.para2,
    })),
    devotional_days: (lesson.devotionals || []).map((d) => ({
      day:       d.day,
      title:     d.title,
      scripture: d.scripture,
    })),
    questions: lesson.questions || [],
    sort_order: lesson.n,
  };
}

async function seedCategory(category, lessons) {
  console.log(`\n📌 Seeding ${category.toUpperCase()} (${lessons.length} lessons)...`);

  // Idempotency: blow away any existing rows under the three category-
  // specific units so re-runs don't accumulate duplicates. CASCADE on the
  // lesson_translations.lesson_id FK takes care of the translation rows.
  await run(
    `DELETE FROM lessons WHERE unit_id IN ($1, $2, $3)`,
    [`${category}_unit_1`, `${category}_unit_2`, `${category}_unit_3`],
  );

  for (const lesson of lessons) {
    const row = toRow(category, lesson);

    const res = await run(
      `INSERT INTO lessons (
         unit_id, category_id, lesson_number, title, lesson_date, topic, quarter_theme,
         suggested_hymns, devotional_reading, memory_verse, memory_verse_passage,
         lesson_background, lesson_conclusion, lesson_part, devotional_days,
         questions, sort_order
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        row.unit_id, row.category_id, row.lesson_number, row.title, row.lesson_date,
        row.topic, row.quarter_theme, row.suggested_hymns, row.devotional_reading,
        row.memory_verse, row.memory_verse_passage, row.lesson_background,
        row.lesson_conclusion,
        JSON.stringify(row.lesson_part),
        JSON.stringify(row.devotional_days),
        JSON.stringify(row.questions),
        row.sort_order,
      ],
    );

    const lessonId = res.rows[0].id;

    // English translation row — mirrors what backend/seed.js writes for the
    // adult lessons, so the read path (LESSON_SELECT in routes/lessons.js)
    // resolves the right title/topic/background per language.
    await run(
      `INSERT INTO lesson_translations (
         lesson_id, lang_code,
         title, topic, memory_verse,
         lesson_background, lesson_conclusion,
         lesson_part, devotional_days, questions,
         topic_for_adults, topic_for_youth,
         topic_for_intermediate, topic_for_children
       ) VALUES (
         $1, 'en',
         $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         $10, $11, $12, $13
       )`,
      [
        lessonId,
        safe(row.title),
        row.topic || null,
        row.memory_verse || null,
        row.lesson_background || null,
        row.lesson_conclusion || null,
        JSON.stringify(row.lesson_part),
        JSON.stringify(row.devotional_days),
        JSON.stringify(row.questions),
        // The four per-audience topics — only the one matching this row's
        // own category is populated; the others stay null so per-category
        // editors don't accidentally show the wrong audience's framing.
        category === 'adult'        ? row.topic : null,
        category === 'youth'        ? row.topic : null,
        category === 'intermediate' ? row.topic : null,
        category === 'children'     ? row.topic : null,
      ],
    );
  }

  log(`Seeded ${lessons.length} ${category} lessons + English translations`);
}

async function main() {
  console.log('\n🌱 Seeding age-category lessons (youth, intermediate, children)...\n');

  // Sanity-check that the units the lessons attach to actually exist. Bail
  // out with a clear message if backend/seed.js hasn't been run first so
  // the FK error doesn't show up halfway through the run.
  const unitCheck = await run(
    `SELECT id FROM units WHERE id LIKE 'youth_unit_%' OR id LIKE 'intermediate_unit_%' OR id LIKE 'children_unit_%'`,
  );
  if (unitCheck.rows.length < 9) {
    console.error(
      '\n❌ Missing units. Expected 9 rows (3 per category × 3 categories) but ' +
      `found ${unitCheck.rows.length}. Run \`node seed.js\` first to create the units.`,
    );
    process.exit(1);
  }

  try {
    await seedCategory('youth',        YOUTH_LESSONS);
    await seedCategory('intermediate', INTERMEDIATE_LESSONS);
    await seedCategory('children',     CHILDREN_LESSONS);
    console.log('\n✅ Done. 39 lessons seeded (13 × 3 categories).\n');
  } catch (e) {
    console.error('\n❌ Seed failed:', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main();
