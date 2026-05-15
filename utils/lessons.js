// utils/lessons.js
// Lesson / unit / quarter translation helpers. mergeLesson + LESSON_SELECT
// drive every public lesson read; the save* helpers UPSERT translation rows
// for admin writes.

const db = require('../db');

function mergeLesson(row) {
  const safeJson = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) {} }
    return [];
  };
  const lesson_part      = safeJson(row.trans_part).length ? safeJson(row.trans_part) : safeJson(row.base_part);
  const devotional_days  = safeJson(row.trans_days).length ? safeJson(row.trans_days) : safeJson(row.base_days);
  const questions        = safeJson(row.trans_q).length    ? safeJson(row.trans_q)    : safeJson(row.base_q);
  const title            = row.trans_title || row.base_title;
  const topic            = row.trans_topic || row.base_topic;
  const memory_verse     = row.trans_mv    || row.base_mv;
  const lesson_background= row.trans_bg    || row.base_bg;
  const lesson_conclusion= row.trans_conc  || row.base_conc;
  return {
    id: row.id, unit_id: row.unit_id, category_id: row.category_id,
    lesson_number: row.lesson_number, title, lesson_date: row.lesson_date, topic,
    quarter_theme: row.quarter_theme, suggested_hymns: row.suggested_hymns,
    devotional_reading: row.devotional_reading, memory_verse,
    memory_verse_passage: row.memory_verse_passage, lesson_background,
    lesson_conclusion, lesson_part, devotional_days, questions, sort_order: row.sort_order,
    content: {
      lesson_number: row.lesson_number, lesson_date: row.lesson_date, topic,
      quarter_theme: row.quarter_theme, suggested_hymns: row.suggested_hymns,
      devotional_reading: row.devotional_reading, memory_verse,
      memoryVerse_bible_passage: row.memory_verse_passage,
      lesson_background, lesson_conclusion, lesson_part, devotional_days, questions,
    },
  };
}

const LESSON_SELECT = `
  SELECT
    l.id, l.unit_id, l.category_id, l.lesson_number, l.lesson_date,
    l.quarter_theme, l.suggested_hymns, l.devotional_reading,
    l.memory_verse_passage, l.sort_order,
    l.title             AS base_title,  l.topic             AS base_topic,
    l.memory_verse      AS base_mv,     l.lesson_background AS base_bg,
    l.lesson_conclusion AS base_conc,   l.lesson_part       AS base_part,
    l.devotional_days   AS base_days,   l.questions         AS base_q,
    lt.title            AS trans_title, lt.topic            AS trans_topic,
    lt.memory_verse     AS trans_mv,    lt.lesson_background AS trans_bg,
    lt.lesson_conclusion AS trans_conc, lt.lesson_part      AS trans_part,
    lt.devotional_days  AS trans_days,  lt.questions        AS trans_q
  FROM lessons l
  LEFT JOIN lesson_translations lt ON lt.lesson_id=l.id AND lt.lang_code=$1
`;

async function saveUnitTranslations(unitId, translations) {
  for (const lang of ['en', 'yo', 'ig', 'ha']) {
    const t = translations[lang];
    if (!t) continue;
    await db.query(`
      INSERT INTO unit_translations (unit_id,lang_code,title,description,lesson_range)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (unit_id,lang_code) DO UPDATE
        SET title=EXCLUDED.title, description=EXCLUDED.description,
            lesson_range=EXCLUDED.lesson_range, updated_at=NOW()
    `, [unitId, lang, t.title || null, t.description || null, t.lesson_range || null]);
  }
}

async function saveLessonTranslations(lessonId, content) {
  for (const lang of ['yo', 'ig', 'ha']) {
    const t = content[lang];
    if (!t) continue;
    await db.query(`
      INSERT INTO lesson_translations
        (lesson_id,lang_code,title,topic,memory_verse,lesson_background,lesson_conclusion,
         lesson_part,devotional_days,questions)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
      ON CONFLICT (lesson_id,lang_code) DO UPDATE SET
        title=EXCLUDED.title, topic=EXCLUDED.topic, memory_verse=EXCLUDED.memory_verse,
        lesson_background=EXCLUDED.lesson_background, lesson_conclusion=EXCLUDED.lesson_conclusion,
        lesson_part=EXCLUDED.lesson_part, devotional_days=EXCLUDED.devotional_days,
        questions=EXCLUDED.questions, updated_at=NOW()
    `, [
      lessonId, lang, t.title || null, t.topic || null, t.memory_verse || null,
      t.background || null, t.conclusion || null,
      JSON.stringify(t.lesson_part || []),
      JSON.stringify(t.devotional_days || []),
      JSON.stringify(t.questions || []),
    ]);
  }
}

async function saveQuarterTranslations(quarterId, translations) {
  if (!translations || typeof translations !== 'object') return;
  for (const [lang, tr] of Object.entries(translations)) {
    await db.query(`
      INSERT INTO quarter_translations (quarter_id,lang_code,theme_title,theme_sub,period,memory_verse)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (quarter_id,lang_code) DO UPDATE SET
        theme_title=$3, theme_sub=$4, period=$5, memory_verse=$6
    `, [quarterId, lang, tr.theme_title || null, tr.theme_sub || null, tr.period || null, tr.memory_verse || null]);
  }
}

module.exports = {
  mergeLesson,
  LESSON_SELECT,
  saveUnitTranslations,
  saveLessonTranslations,
  saveQuarterTranslations,
};
