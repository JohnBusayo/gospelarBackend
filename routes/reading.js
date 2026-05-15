// routes/reading.js
// Daily reading tracker — streaks, XP, levels, badges. All endpoints keyed
// by `email` (no token), matching the trust model of /api/quiz/submit.
//
// Streak rule: yesterday → +1, today → no-op, anything older → reset to 1.

const express = require('express');
const db = require('../db');
const { isValidEmail } = require('../utils/helpers');

const router = express.Router();

const READING_XP = {
  CHECK_IN:        10,
  PER_5_MIN:        5,
  TIME_BONUS_CAP:  20,
  BADGE_UNLOCK:    50,
};

// Each badge unlocks the first time `predicate(stats)` flips true.
const BADGE_CATALOG = [
  { id: 'first_lesson',    title: 'First Lesson Read',    emoji: '📖', desc: 'Open and read a Sunday-school lesson for the first time.', predicate: (s) => s.total_days_read >= 1 },
  { id: 'streak_3',        title: 'Getting Started',      emoji: '✨', desc: 'Read for 3 days in a row.', predicate: (s) => s.current_streak >= 3 },
  { id: 'streak_7',        title: '7-Day Reader',         emoji: '🔥', desc: 'A whole week of consecutive reading.', predicate: (s) => s.current_streak >= 7 },
  { id: 'streak_30',       title: 'Faithful Reader',      emoji: '💪', desc: '30 days in a row — a habit is forming.', predicate: (s) => s.current_streak >= 30 },
  { id: 'streak_100',      title: '100-Day Disciple',     emoji: '👑', desc: 'Three months of unbroken devotion.', predicate: (s) => s.current_streak >= 100 },
  { id: 'genesis_unit',    title: 'Genesis Completed',    emoji: '🌟', desc: 'Read 13 distinct lessons — one quarter\'s worth.', predicate: (s) => s.distinct_lessons_read >= 13 },
  { id: 'prayer_warrior',  title: 'Prayer Warrior',       emoji: '🙏', desc: '30 days of devotional reading.', predicate: (s) => s.devotional_days >= 30 },
];

const xpToLevel = (xp) => {
  // level n requires xp >= 100*(n-1)^2 → level = floor(sqrt(xp/100)) + 1
  const lvl  = Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
  const base = 100 * (lvl - 1) * (lvl - 1);
  const next = 100 * lvl * lvl;
  return {
    level:                 lvl,
    xp_into_level:         xp - base,
    xp_for_next:           next - base,
    level_progress_pct:    next === base ? 0 : Math.round(((xp - base) / (next - base)) * 100),
  };
};

async function readingStatsCore(email) {
  const lc = email.toLowerCase();
  const profileR = await db.query(
    `SELECT COALESCE(current_streak,0) AS current_streak,
            COALESCE(longest_streak,0) AS longest_streak,
            last_read_date,
            COALESCE(lifetime_xp,0)    AS lifetime_xp,
            COALESCE(badges,'[]'::jsonb) AS badges
       FROM user_profiles WHERE email = $1`, [lc]);
  const p = profileR.rows[0] || { current_streak: 0, longest_streak: 0, last_read_date: null, lifetime_xp: 0, badges: [] };

  const aggR = await db.query(
    `SELECT
        COUNT(*)::int                                            AS total_days_read,
        COUNT(DISTINCT lesson_id) FILTER (WHERE lesson_id IS NOT NULL)::int AS distinct_lessons_read,
        COUNT(*) FILTER (WHERE source_type = 'devotional')::int  AS devotional_days,
        COUNT(*) FILTER (WHERE reading_date >= CURRENT_DATE - INTERVAL '6 days')::int  AS this_week,
        COUNT(*) FILTER (WHERE reading_date >= CURRENT_DATE - INTERVAL '29 days')::int AS this_month
       FROM daily_reading_log WHERE email = $1`, [lc]);
  const a = aggR.rows[0];
  return {
    current_streak:        p.current_streak,
    longest_streak:        p.longest_streak,
    last_read_date:        p.last_read_date,
    lifetime_xp:           p.lifetime_xp,
    badges:                Array.isArray(p.badges) ? p.badges : [],
    total_days_read:       a.total_days_read,
    distinct_lessons_read: a.distinct_lessons_read,
    devotional_days:       a.devotional_days,
    this_week:             a.this_week,
    this_month:            a.this_month,
  };
}

router.post('/api/reading/check-in', async (req, res) => {
  const { email, source_type, lesson_id, duration_seconds } = req.body || {};
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });
  const lc       = String(email).toLowerCase();
  const src      = ['lesson', 'devotional', 'manual'].includes(source_type) ? source_type : 'lesson';
  const lessonId = Number.isFinite(parseInt(lesson_id, 10)) ? parseInt(lesson_id, 10) : null;
  const dur      = Math.max(0, Math.min(parseInt(duration_seconds, 10) || 0, 4 * 3600));

  try {
    await db.query(
      `INSERT INTO user_profiles (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [lc]
    );

    const existR = await db.query(
      `SELECT id, duration_seconds FROM daily_reading_log
        WHERE email = $1 AND reading_date = CURRENT_DATE`, [lc]);

    let alreadyCheckedIn = false;
    let bonusXp = 0;

    if (existR.rows.length) {
      // Same-day → keep one row, accumulate duration (capped), award any new
      // time-bonus XP since the last check-in.
      alreadyCheckedIn = true;
      const oldDur = existR.rows[0].duration_seconds || 0;
      const newDur = Math.min(oldDur + dur, 4 * 3600);
      const oldBonus = Math.min(Math.floor(oldDur / 300) * READING_XP.PER_5_MIN, READING_XP.TIME_BONUS_CAP);
      const newBonus = Math.min(Math.floor(newDur / 300) * READING_XP.PER_5_MIN, READING_XP.TIME_BONUS_CAP);
      bonusXp = newBonus - oldBonus;
      await db.query(
        `UPDATE daily_reading_log
            SET duration_seconds = $2,
                source_type = COALESCE(source_type, $3),
                lesson_id   = COALESCE(lesson_id, $4)
          WHERE id = $1`, [existR.rows[0].id, newDur, src, lessonId]);
    } else {
      await db.query(
        `INSERT INTO daily_reading_log (email, reading_date, source_type, lesson_id, duration_seconds)
         VALUES ($1, CURRENT_DATE, $2, $3, $4)`,
        [lc, src, lessonId, dur]);
      bonusXp = READING_XP.CHECK_IN
              + Math.min(Math.floor(dur / 300) * READING_XP.PER_5_MIN, READING_XP.TIME_BONUS_CAP);
    }

    // Recompute streak from last_read_date.
    let streakInc = 0;
    let didReset  = false;
    if (!alreadyCheckedIn) {
      const lr = (await db.query(`SELECT last_read_date FROM user_profiles WHERE email=$1`, [lc])).rows[0];
      const lastDate = lr?.last_read_date ? new Date(lr.last_read_date) : null;
      const today    = new Date(); today.setUTCHours(0, 0, 0, 0);
      const yesterday = new Date(today); yesterday.setUTCDate(today.getUTCDate() - 1);
      if (lastDate && lastDate.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10)) {
        streakInc = 1;
      } else {
        didReset = lastDate != null;
        streakInc = -999; // sentinel: replace, not increment
      }
      const newStreak = streakInc === -999 ? 1 : null;
      await db.query(
        `UPDATE user_profiles
            SET current_streak = ${newStreak !== null ? '$2' : 'COALESCE(current_streak,0) + 1'},
                longest_streak = GREATEST(COALESCE(longest_streak,0), ${newStreak !== null ? '$2' : 'COALESCE(current_streak,0) + 1'}),
                last_read_date = CURRENT_DATE,
                lifetime_xp    = COALESCE(lifetime_xp,0) + $3
          WHERE email = $1`,
        newStreak !== null ? [lc, newStreak, bonusXp] : [lc, bonusXp]);
    } else if (bonusXp > 0) {
      await db.query(
        `UPDATE user_profiles SET lifetime_xp = COALESCE(lifetime_xp,0) + $2 WHERE email = $1`,
        [lc, bonusXp]);
    }

    // Award any newly-unlocked badges (each pays out BADGE_UNLOCK XP once).
    const stats = await readingStatsCore(lc);
    const owned = new Set(stats.badges.map((b) => (typeof b === 'string' ? b : b.id)));
    const newlyEarned = [];
    for (const b of BADGE_CATALOG) {
      if (!owned.has(b.id) && b.predicate(stats)) {
        newlyEarned.push({ id: b.id, title: b.title, emoji: b.emoji, unlocked_at: new Date().toISOString() });
      }
    }
    if (newlyEarned.length) {
      const merged    = [...stats.badges, ...newlyEarned];
      const badgeXp   = newlyEarned.length * READING_XP.BADGE_UNLOCK;
      await db.query(
        `UPDATE user_profiles SET badges = $2::jsonb, lifetime_xp = COALESCE(lifetime_xp,0) + $3 WHERE email = $1`,
        [lc, JSON.stringify(merged), badgeXp]);
      stats.badges      = merged;
      stats.lifetime_xp += badgeXp;
      bonusXp           += badgeXp;
    }

    res.json({
      already_checked_in: alreadyCheckedIn,
      streak_reset:       didReset,
      xp_awarded:         bonusXp,
      new_badges:         newlyEarned,
      ...stats,
      ...xpToLevel(stats.lifetime_xp),
    });
  } catch (e) {
    console.error('POST /api/reading/check-in:', e.code, e.message);
    res.status(500).json({ error: 'Check-in failed.' });
  }
});

router.get('/api/reading/stats/:email', async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });
  try {
    await db.query(`INSERT INTO user_profiles (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);

    const stats = await readingStatsCore(email);

    const todayR = await db.query(
      `SELECT source_type, duration_seconds, lesson_id
         FROM daily_reading_log
        WHERE email = $1 AND reading_date = CURRENT_DATE`, [email]);

    const recentR = await db.query(
      `SELECT reading_date, source_type, duration_seconds, lesson_id
         FROM daily_reading_log
        WHERE email = $1
        ORDER BY reading_date DESC
        LIMIT 14`, [email]);

    res.json({
      email,
      checked_in_today: todayR.rows.length > 0,
      today:            todayR.rows[0] || null,
      ...stats,
      ...xpToLevel(stats.lifetime_xp),
      recent_log:       recentR.rows,
      badge_catalog:    BADGE_CATALOG.map(({ id, title, emoji, desc }) => ({ id, title, emoji, desc })),
    });
  } catch (e) {
    console.error('GET /api/reading/stats:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load reading stats.' });
  }
});

router.get('/api/reading/calendar/:email', async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  const days  = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });
  try {
    const r = await db.query(
      `WITH days AS (
         SELECT generate_series(CURRENT_DATE - ($1 - 1)::int, CURRENT_DATE, '1 day')::date AS d
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
              (drl.email IS NOT NULL)       AS checked_in,
              drl.source_type,
              COALESCE(drl.duration_seconds, 0) AS duration_seconds
         FROM days
         LEFT JOIN daily_reading_log drl
           ON drl.email = $2 AND drl.reading_date = days.d
        ORDER BY days.d`, [days, email]);
    res.json({ email, days, calendar: r.rows });
  } catch (e) {
    console.error('GET /api/reading/calendar:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load calendar.' });
  }
});

router.get('/api/reading/leaderboard', async (req, res) => {
  const scope = req.query.scope === 'church' ? 'church' : 'global';
  const days  = req.query.days === 'all' ? null : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  let churchId = null;
  if (scope === 'church') {
    const masterKey = req.headers['x-admin-key'];
    if (!masterKey || masterKey !== process.env.ADMIN_SECRET) {
      const ck = req.headers['x-church-key'];
      if (!ck) return res.status(401).json({ error: 'church scope requires x-church-key' });
      const cR = await db.query(`SELECT id FROM churches WHERE admin_token = $1 AND COALESCE(approval_status,'approved') = 'approved'`, [ck]);
      if (!cR.rows.length) return res.status(403).json({ error: 'Invalid church token.' });
      churchId = cR.rows[0].id;
    }
  }

  try {
    let r;
    if (days === null) {
      const params = [];
      let where = `WHERE COALESCE(up.lifetime_xp,0) > 0`;
      if (churchId) { params.push(churchId); where += ` AND u.church_id = $${params.length}`; }
      r = await db.query(`
        SELECT
          ROW_NUMBER() OVER (ORDER BY COALESCE(up.lifetime_xp,0) DESC) AS rank,
          up.email,
          COALESCE(up.display_name, u.full_name, split_part(up.email, '@', 1)) AS display_name,
          COALESCE(up.avatar_emoji, '👤') AS avatar_emoji,
          COALESCE(up.current_streak,0)  AS current_streak,
          COALESCE(up.longest_streak,0)  AS longest_streak,
          COALESCE(up.lifetime_xp,0)     AS lifetime_xp,
          jsonb_array_length(COALESCE(up.badges,'[]'::jsonb)) AS badges_count
        FROM user_profiles up
        LEFT JOIN users u ON u.email = up.email
        ${where}
        ORDER BY lifetime_xp DESC
        LIMIT 20
      `, params);
    } else {
      const params = [days];
      let where = `WHERE drl.reading_date >= CURRENT_DATE - ($1 - 1)::int`;
      if (churchId) { params.push(churchId); where += ` AND u.church_id = $${params.length}`; }
      r = await db.query(`
        SELECT
          ROW_NUMBER() OVER (ORDER BY COUNT(drl.id) DESC, COALESCE(MAX(up.lifetime_xp),0) DESC) AS rank,
          drl.email,
          COALESCE(MAX(up.display_name), MAX(u.full_name), split_part(drl.email, '@', 1)) AS display_name,
          COALESCE(MAX(up.avatar_emoji), '👤') AS avatar_emoji,
          COALESCE(MAX(up.current_streak),0)  AS current_streak,
          COALESCE(MAX(up.longest_streak),0)  AS longest_streak,
          COALESCE(MAX(up.lifetime_xp),0)     AS lifetime_xp,
          COUNT(drl.id)::int                  AS days_in_window,
          jsonb_array_length(COALESCE(MAX(up.badges),'[]'::jsonb)) AS badges_count
        FROM daily_reading_log drl
        LEFT JOIN user_profiles up ON up.email = drl.email
        LEFT JOIN users u         ON u.email   = drl.email
        ${where}
        GROUP BY drl.email
        ORDER BY days_in_window DESC, lifetime_xp DESC
        LIMIT 20
      `, params);
    }
    res.json({ scope, days, count: r.rows.length, leaders: r.rows });
  } catch (e) {
    console.error('GET /api/reading/leaderboard:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
});

module.exports = router;
