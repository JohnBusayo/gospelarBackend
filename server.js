const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const cors    = require('cors');
const axios   = require('axios');
const db      = require('./db');
const { sendApprovalEmail, sendRejectionEmail } = require('./services/mailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE SCHEMA
// Each step is a SEPARATE array element — safe for any DB state
// ─────────────────────────────────────────────────────────────────────────────
const initDb = async () => {
  const steps = [

    // ── Ad banners ──────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS ad_banners (
      id           SERIAL PRIMARY KEY,
      title        TEXT,
      image_base64 TEXT,
      image_url    TEXT,
      link_url     TEXT,
      is_active    BOOLEAN DEFAULT FALSE,
      scheduled_at TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ── Bible verses ────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS bible_verses (
      id         SERIAL PRIMARY KEY,
      reference  TEXT UNIQUE NOT NULL,
      text       TEXT NOT NULL,
      version    TEXT DEFAULT 'KJV',
      added_by   TEXT DEFAULT 'admin',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ── Quarter info ────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS quarter_info (
      id           SERIAL PRIMARY KEY,
      quarter      TEXT    NOT NULL DEFAULT 'Q4 2026',
      year         INTEGER NOT NULL DEFAULT 2026,
      theme_title  TEXT    NOT NULL,
      theme_sub    TEXT,
      book         TEXT,
      book_full    TEXT,
      lesson_count INTEGER DEFAULT 13,
      period       TEXT,
      memory_verse TEXT,
      is_current   BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ── Quarter translations ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS quarter_translations (
      id           SERIAL PRIMARY KEY,
      quarter_id   INTEGER NOT NULL REFERENCES quarter_info(id) ON DELETE CASCADE,
      lang_code    VARCHAR(10) NOT NULL,
      theme_title  TEXT,
      theme_sub    TEXT,
      period       TEXT,
      memory_verse TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(quarter_id, lang_code)
    )`,

    // ── Languages ───────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS languages (
      code         VARCHAR(10)  PRIMARY KEY,
      label        VARCHAR(100) NOT NULL,
      native_label VARCHAR(100) NOT NULL,
      flag         VARCHAR(10)  DEFAULT '',
      is_active    BOOLEAN      DEFAULT TRUE,
      created_at   TIMESTAMPTZ  DEFAULT NOW()
    )`,

    `INSERT INTO languages (code, label, native_label, flag) VALUES
      ('en', 'English', 'English',       '🇬🇧'),
      ('yo', 'Yoruba',  'Yorùbá',        '🇳🇬'),
      ('ig', 'Igbo',    'Ígbò',          '🇳🇬'),
      ('ha', 'Hausa',   'Harshen Hausa', '🇳🇬')
     ON CONFLICT (code) DO NOTHING`,

    // ── Categories ──────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS categories (
      id          VARCHAR(50)  PRIMARY KEY,
      label       VARCHAR(100) NOT NULL,
      description TEXT,
      color       VARCHAR(20)  DEFAULT '#2563EB',
      icon        VARCHAR(10)  DEFAULT '📖',
      sort_order  INTEGER      DEFAULT 0
    )`,

    `INSERT INTO categories (id, label, description, color, icon, sort_order) VALUES
      ('adult',        'Adult Class',        'Expository study for adult members',         '#7C3AED','📖',1),
      ('youth',        'Youth Class',        'Life-application lessons for young people',  '#2563EB','⚡',2),
      ('intermediate', 'Intermediate Class', 'Bridge lessons for teens and young adults',  '#10B981','🌱',3),
      ('children',     'Children''s Class',  'Simple, illustrated lessons for children',   '#F97316','🌟',4)
     ON CONFLICT (id) DO UPDATE
       SET label=EXCLUDED.label, description=EXCLUDED.description,
           color=EXCLUDED.color, icon=EXCLUDED.icon`,

    // ── Category translations ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS category_translations (
      id          SERIAL       PRIMARY KEY,
      category_id VARCHAR(50)  NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      lang_code   VARCHAR(10)  NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
      label       VARCHAR(100),
      description TEXT,
      updated_at  TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (category_id, lang_code)
    )`,

    // ── Units ───────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS units (
      id           VARCHAR(50)  PRIMARY KEY,
      category_id  VARCHAR(50)  NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      title        VARCHAR(255) NOT NULL,
      description  TEXT,
      lesson_range VARCHAR(50),
      color        VARCHAR(20),
      sort_order   INTEGER DEFAULT 0
    )`,

    // ── Unit translations ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS unit_translations (
      id           SERIAL       PRIMARY KEY,
      unit_id      VARCHAR(50)  NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      lang_code    VARCHAR(10)  NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
      title        VARCHAR(255),
      description  TEXT,
      lesson_range VARCHAR(50),
      updated_at   TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (unit_id, lang_code)
    )`,

    // ── Lessons ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS lessons (
      id                   SERIAL       PRIMARY KEY,
      unit_id              VARCHAR(50)  NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      category_id          VARCHAR(50)  NOT NULL REFERENCES categories(id),
      lesson_number        INT          NOT NULL,
      title                VARCHAR(255) NOT NULL,
      lesson_date          VARCHAR(50),
      topic                TEXT,
      quarter_theme        TEXT,
      suggested_hymns      TEXT,
      devotional_reading   TEXT,
      memory_verse         TEXT,
      memory_verse_passage VARCHAR(200),
      lesson_background    TEXT,
      lesson_conclusion    TEXT,
      lesson_part          JSONB DEFAULT '[]'::jsonb,
      devotional_days      JSONB DEFAULT '[]'::jsonb,
      questions            JSONB DEFAULT '[]'::jsonb,
      sort_order           INTEGER DEFAULT 0,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (unit_id, lesson_number)
    )`,

    // ── Lesson translations ──────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS lesson_translations (
      id               SERIAL       PRIMARY KEY,
      lesson_id        INTEGER      NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      lang_code        VARCHAR(10)  NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
      title            VARCHAR(255),
      topic            TEXT,
      memory_verse     TEXT,
      lesson_background  TEXT,
      lesson_conclusion  TEXT,
      lesson_part      JSONB DEFAULT '[]'::jsonb,
      devotional_days  JSONB DEFAULT '[]'::jsonb,
      questions        JSONB DEFAULT '[]'::jsonb,
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (lesson_id, lang_code)
    )`,

    // ── UI translations ──────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS translations (
      id         SERIAL       PRIMARY KEY,
      lang_code  VARCHAR(10)  NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
      key        VARCHAR(200) NOT NULL,
      value      TEXT         NOT NULL,
      updated_at TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (lang_code, key)
    )`,

    // ── Category default language ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS category_languages (
      category_id VARCHAR(50) PRIMARY KEY,
      lang_code   VARCHAR(10) NOT NULL REFERENCES languages(code)
    )`,

    `INSERT INTO category_languages (category_id, lang_code) VALUES
      ('adult','en'),('youth','en'),('intermediate','en'),('children','en')
     ON CONFLICT (category_id) DO NOTHING`,

    // ── Quiz questions ───────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS lesson_quizzes (
      id             SERIAL  PRIMARY KEY,
      lesson_id      INT     NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      question       TEXT    NOT NULL,
      options        JSONB   NOT NULL DEFAULT '{}'::jsonb,
      correct_answer TEXT    NOT NULL,
      points         INT     DEFAULT 10,
      category_id    TEXT    DEFAULT 'all',
      lang           TEXT    DEFAULT 'en'
    )`,

    // ── Users ────────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
      id            SERIAL       PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT         NOT NULL,
      full_name     VARCHAR(200),
      role          VARCHAR(20)  DEFAULT 'student',
      session_token TEXT,
      session_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ  DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  DEFAULT NOW()
    )`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role          VARCHAR(20) DEFAULT 'student'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_at    TIMESTAMPTZ`,

    // ── User profiles ────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS user_profiles (
      email         VARCHAR(255) PRIMARY KEY,
      display_name  VARCHAR(100),
      avatar_emoji  VARCHAR(10)  DEFAULT '👤',
      church        VARCHAR(200),
      location      VARCHAR(200),
      lang_pref     VARCHAR(10)  DEFAULT 'en',
      dark_mode     BOOLEAN      DEFAULT FALSE,
      notifications BOOLEAN      DEFAULT TRUE,
      created_at    TIMESTAMPTZ  DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  DEFAULT NOW()
    )`,

    // ── User scores ──────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS user_scores (
      id           SERIAL       PRIMARY KEY,
      email        VARCHAR(255) NOT NULL,
      lesson_id    INT          NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      score        INT          NOT NULL,
      max_score    INT,
      completed_at TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (email, lesson_id)
    )`,

    // ── Subscribers ──────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscribers (
      id                  SERIAL       PRIMARY KEY,
      email               VARCHAR(255) UNIQUE NOT NULL,
      is_active           BOOLEAN      DEFAULT FALSE,
      subscription_date   TIMESTAMPTZ,
      expiry_date         TIMESTAMPTZ,
      paystack_ref        TEXT,
      subscribed_category VARCHAR(20)  DEFAULT 'adult',
      plan_type           VARCHAR(20)  DEFAULT 'single',
      price_kobo          INTEGER      DEFAULT 50000,
      created_at          TIMESTAMPTZ  DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  DEFAULT NOW()
    )`,

    // Safe migrations for existing databases without these columns
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS subscribed_category VARCHAR(20) DEFAULT 'adult'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan_type           VARCHAR(20) DEFAULT 'single'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS price_kobo          INTEGER     DEFAULT 50000`,

    // ── Subscription plan pricing (admin-editable) ───────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_plans (
      plan_id     VARCHAR(20)  PRIMARY KEY,
      price_kobo  INTEGER      NOT NULL,
      days        INTEGER      NOT NULL DEFAULT 300,
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    )`,
    `INSERT INTO subscription_plans (plan_id, price_kobo, days) VALUES
       ('single', 50000,  300),
       ('all',    100000, 300)
     ON CONFLICT (plan_id) DO NOTHING`,

    // ── Hymns ────────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS hymns (
      id     SERIAL PRIMARY KEY,
      number INT    UNIQUE NOT NULL,
      title  TEXT   NOT NULL,
      author TEXT,
      chorus TEXT,
      verses JSONB  NOT NULL DEFAULT '[]'::jsonb
    )`,

    // ── Churches — top-level org unit. Each teacher belongs to one church,
    //    each church has one admin. Insight endpoints filter by church_id so
    //    Church A's admin only ever sees Church A's data.
    `CREATE TABLE IF NOT EXISTS churches (
      id           SERIAL       PRIMARY KEY,
      name         VARCHAR(200) NOT NULL,
      location     VARCHAR(200),
      admin_email  VARCHAR(255) NOT NULL,
      admin_token  VARCHAR(80)  NOT NULL,            -- per-church secret used as x-church-key
      invite_code  VARCHAR(20)  UNIQUE NOT NULL,     -- 6-8 char code teachers paste at signup
      created_at   TIMESTAMPTZ  DEFAULT NOW()
    )`,

    // Link teachers to their church via the users table (every teacher already
    // has a row in `users`). Nullable for back-compat with existing teachers
    // created before this change — they can be assigned later from admin.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS church_id INT REFERENCES churches(id) ON DELETE SET NULL`,

    // ── Teacher / class system ───────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS classes (
      id                  SERIAL       PRIMARY KEY,
      teacher_email       VARCHAR(255) NOT NULL,
      name                VARCHAR(200) NOT NULL,
      description         TEXT,
      category            VARCHAR(50)  DEFAULT 'adult',
      subscribed_category VARCHAR(20)  DEFAULT 'adult',
      invite_code         VARCHAR(20)  UNIQUE,
      church_id           INT          REFERENCES churches(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ  DEFAULT NOW()
    )`,
    // Back-compat: add church_id to existing classes table if it's missing.
    `ALTER TABLE classes ADD COLUMN IF NOT EXISTS church_id INT REFERENCES churches(id) ON DELETE SET NULL`,

    `CREATE TABLE IF NOT EXISTS class_members (
      id            SERIAL       PRIMARY KEY,
      class_id      INT          REFERENCES classes(id) ON DELETE CASCADE,
      student_email VARCHAR(255) NOT NULL,
      joined_at     TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (class_id, student_email)
    )`,

    `CREATE TABLE IF NOT EXISTS attendance (
      id            SERIAL       PRIMARY KEY,
      class_id      INT          REFERENCES classes(id) ON DELETE CASCADE,
      lesson_number INT          NOT NULL,
      student_email VARCHAR(255) NOT NULL,
      present       BOOLEAN      DEFAULT FALSE,
      marked_by     VARCHAR(255),
      marked_at     TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (class_id, lesson_number, student_email)
    )`,

    `CREATE TABLE IF NOT EXISTS teacher_marks (
      id            SERIAL       PRIMARY KEY,
      class_id      INT          REFERENCES classes(id) ON DELETE CASCADE,
      lesson_number INT          NOT NULL,
      student_email VARCHAR(255) NOT NULL,
      mark_type     VARCHAR(50)  NOT NULL,
      points        INT          DEFAULT 0,
      note          TEXT,
      awarded_by    VARCHAR(255),
      awarded_at    TIMESTAMPTZ  DEFAULT NOW()
    )`,

    // church_id back-fill on attendance + teacher_marks so we can filter
    // insight queries by church in O(1) instead of joining through classes.
    `ALTER TABLE attendance    ADD COLUMN IF NOT EXISTS church_id INT REFERENCES churches(id) ON DELETE SET NULL`,
    `ALTER TABLE teacher_marks ADD COLUMN IF NOT EXISTS church_id INT REFERENCES churches(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_church    ON attendance(church_id)`,
    `CREATE INDEX IF NOT EXISTS idx_teacher_marks_church ON teacher_marks(church_id)`,
    `CREATE INDEX IF NOT EXISTS idx_classes_church       ON classes(church_id)`,

    // ── Trigger: auto-update updated_at ──────────────────────────────────────
    `CREATE OR REPLACE FUNCTION update_updated_at()
     RETURNS TRIGGER AS $$
     BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
     $$ LANGUAGE plpgsql`,

    `DROP TRIGGER IF EXISTS subscribers_updated_at ON subscribers`,
    `CREATE TRIGGER subscribers_updated_at
       BEFORE UPDATE ON subscribers
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

    // ── Live migrations (idempotent) ─────────────────────────────────────────
    `ALTER TABLE units ADD COLUMN IF NOT EXISTS category_id VARCHAR(50) DEFAULT 'adult'`,

    `UPDATE units SET category_id = CASE
       WHEN id LIKE 'adult_%'        THEN 'adult'
       WHEN id LIKE 'youth_%'        THEN 'youth'
       WHEN id LIKE 'intermediate_%' THEN 'intermediate'
       WHEN id LIKE 'children_%'     THEN 'children'
       ELSE 'adult'
     END
     WHERE category_id IS NULL
        OR category_id NOT IN ('adult','youth','intermediate','children')`,

    `ALTER TABLE lessons ADD COLUMN IF NOT EXISTS category_id VARCHAR(50) DEFAULT 'adult'`,

    `UPDATE lessons l SET category_id = u.category_id
     FROM units u WHERE l.unit_id = u.id
       AND (l.category_id IS NULL
         OR l.category_id NOT IN ('adult','youth','intermediate','children'))`,

    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name='units_category_id_fk' AND table_name='units'
       ) THEN
         ALTER TABLE units ADD CONSTRAINT units_category_id_fk
           FOREIGN KEY (category_id) REFERENCES categories(id);
       END IF;
     END $$`,

    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name='lessons_unit_lesson_unique' AND table_name='lessons'
       ) THEN
         ALTER TABLE lessons ADD CONSTRAINT lessons_unit_lesson_unique
           UNIQUE (unit_id, lesson_number);
       END IF;
     END $$`,

    `ALTER TABLE units DROP COLUMN IF EXISTS category`,

    // ── Church admin self-service signup + main-admin approval flow ──────────
    // Existing churches keep approval_status='approved' (default), so the
    // manual /api/admin/churches creation flow is unaffected.
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS password_hash      TEXT`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS contact_name       VARCHAR(150)`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS phone              VARCHAR(50)`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS approval_status    VARCHAR(20) DEFAULT 'approved'`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS rejected_reason    TEXT`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS rejected_at        TIMESTAMPTZ`,

    // ── Teacher approval — church admin authorizes new teachers ──────────────
    // Existing users keep approval_status='approved' (default). New teacher
    // signups (after this migration runs) explicitly land as 'pending'.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status   VARCHAR(20) DEFAULT 'approved'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by_email VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_reason   TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at       TIMESTAMPTZ`,
    // Make email unique so signup can detect duplicates cleanly.
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'churches_admin_email_key'
       ) THEN
         ALTER TABLE churches ADD CONSTRAINT churches_admin_email_key UNIQUE (admin_email);
       END IF;
     END $$`,
  ];

  for (const sql of steps) {
    try {
      await db.query(sql);
    } catch (err) {
      if (!(err.message || '').includes('already exists')) {
        // Log code + message + first SQL token so connection errors (which
        // have empty .message) still surface a useful clue.
        console.error('DB step failed:',
          err.code || '(no code)',
          err.message || '(no message)',
          '— stmt:', String(sql).trim().slice(0, 80));
      }
    }
  }

  // Seed default quarter if empty
  const qi = await db.query('SELECT COUNT(*) FROM quarter_info');
  if (parseInt(qi.rows[0].count, 10) === 0) {
    await db.query(`
      INSERT INTO quarter_info
        (quarter,year,theme_title,theme_sub,book,book_full,lesson_count,period,memory_verse,is_current)
      VALUES
        ('Q4 2026',2026,'Demonstration of the Christian Life',
         'Exposition on the Book of Philemon','Philemon','Book of Philemon',13,
         'October – December 2026','Philemon 1:1–25',TRUE)
    `);
    console.log('✅ quarter_info seeded.');
  }
  console.log('✅ DB ready.');
};

initDb().catch(err =>
  console.error('initDb failed:',
    err.code || '(no code)',
    err.message || '(no message)',
    '\nstack:', err.stack));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isValidEmail      = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const addDays           = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const SUBSCRIPTION_DAYS = 300;

const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Per-church admin auth — used by the church admin dashboard. Reads the
// `x-church-key` header, looks up which church it belongs to, and attaches
// `req.church = { id, name, ... }` to the request. Master ADMIN_SECRET also
// works (treated as super-admin with no church scope; req.church = null).
const churchAuth = async (req, res, next) => {
  const masterKey = req.headers['x-admin-key'];
  if (masterKey && masterKey === process.env.ADMIN_SECRET) {
    req.church = null;   // super-admin — no church filter
    return next();
  }
  const churchKey = req.headers['x-church-key'];
  if (!churchKey) return res.status(401).json({ error: 'Missing x-church-key (or x-admin-key for super-admin).' });
  try {
    const r = await db.query(
      'SELECT id, name, location, admin_email, invite_code, approval_status FROM churches WHERE admin_token = $1',
      [churchKey]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'Invalid church token.' });
    // Pending or rejected churches have a token but cannot use it until the
    // main admin approves them.
    if (r.rows[0].approval_status !== 'approved') {
      return res.status(403).json({
        error: 'church_not_approved',
        status: r.rows[0].approval_status,
        message: 'This church account is not approved yet. Wait for the main admin to authorize it.',
      });
    }
    req.church = r.rows[0];
    next();
  } catch (e) {
    console.error('churchAuth:', e.message);
    res.status(500).json({ error: 'Auth check failed.' });
  }
};

// Helper for church-scoped queries: returns "AND church_id = $X" + the param,
// or "" + no param if super-admin. Keeps endpoint code clean.
const churchScope = (req, paramIndex) => {
  if (!req.church) return { sql: '', params: [] };
  return { sql: ` AND church_id = $${paramIndex}`, params: [req.church.id] };
};

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ status:'ok', timestamp:new Date().toISOString() })
);

// ─────────────────────────────────────────────────────────────────────────────
// CHURCHES — top-level org. Super-admin creates them; each church gets its
// own admin_token (used as x-church-key) and invite_code (used by teachers).
// ─────────────────────────────────────────────────────────────────────────────

// Generate URL-safe random tokens for new churches.
const randCode = (len = 8) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/I/1 to avoid confusion
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};
const randToken = () => Array.from({length: 4}, () => randCode(8)).join('-');

// Super-admin creates a church. Body: { name, location, admin_email }
// Returns the new admin_token + invite_code — show these to the church admin
// once at creation time (they paste admin_token into the dashboard, give the
// invite_code to their teachers).
app.post('/api/admin/churches', adminAuth, async (req, res) => {
  const { name, location, admin_email } = req.body || {};
  if (!name || !admin_email) return res.status(400).json({ error: 'name and admin_email required.' });
  if (!isValidEmail(admin_email))         return res.status(400).json({ error: 'Invalid admin_email.' });
  try {
    // Loop until we hit a unique invite_code (collisions extremely rare with 8 chars).
    let inviteCode, attempts = 0;
    while (attempts++ < 10) {
      inviteCode = randCode(8);
      const dup = await db.query('SELECT 1 FROM churches WHERE invite_code = $1', [inviteCode]);
      if (!dup.rows.length) break;
    }
    const adminToken = randToken();
    const r = await db.query(`
      INSERT INTO churches (name, location, admin_email, admin_token, invite_code)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, location, admin_email, invite_code, admin_token, created_at
    `, [name.trim(), (location || '').trim() || null, admin_email.toLowerCase(), adminToken, inviteCode]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('POST /api/admin/churches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create church.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN SELF-SERVICE SIGNUP / LOGIN
// ─────────────────────────────────────────────────────────────────────────────
// Anyone can sign up as a church admin via church-admin.html. The new church
// row starts with approval_status='pending' and cannot use its admin_token to
// hit any /api/admin/insights/* endpoint until the master admin approves it.
//
// Login then exchanges email+password for the admin_token, but only if the
// church is approved.

// POST /api/church-admin/signup  (public)
// Body: { church_name, location, contact_name, admin_email, phone, password }
app.post('/api/church-admin/signup', async (req, res) => {
  const {
    church_name, location, contact_name,
    admin_email, phone, password,
  } = req.body || {};

  if (!church_name || !admin_email || !password)
    return res.status(400).json({ error: 'church_name, admin_email and password are required.' });
  if (!isValidEmail(admin_email))
    return res.status(400).json({ error: 'Invalid admin_email.' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    // Reject duplicate email.
    const dup = await db.query(
      'SELECT id, approval_status FROM churches WHERE admin_email = $1',
      [admin_email.toLowerCase()]
    );
    if (dup.rows.length) {
      const status = dup.rows[0].approval_status;
      const msg = status === 'pending'  ? 'An application with this email is already pending review.'
                : status === 'rejected' ? 'An earlier application with this email was rejected. Contact the main admin.'
                                        : 'An account with this email already exists. Sign in instead.';
      return res.status(409).json({ error: msg, status });
    }

    // Reserve a unique invite_code now so we don't fight uniqueness later.
    let inviteCode, attempts = 0;
    while (attempts++ < 10) {
      inviteCode = randCode(8);
      const dupCode = await db.query('SELECT 1 FROM churches WHERE invite_code = $1', [inviteCode]);
      if (!dupCode.rows.length) break;
    }
    const adminToken = randToken();
    const hash = await bcrypt.hash(password, 12);

    const r = await db.query(`
      INSERT INTO churches (
        name, location, admin_email, admin_token, invite_code,
        password_hash, contact_name, phone, approval_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id, name, admin_email, approval_status, created_at
    `, [
      church_name.trim(),
      (location     || '').trim() || null,
      admin_email.toLowerCase(),
      adminToken,
      inviteCode,
      hash,
      (contact_name || '').trim() || null,
      (phone        || '').trim() || null,
    ]);

    res.status(201).json({
      message: 'Application submitted. The main admin will review your church and approve access shortly.',
      church: r.rows[0],
    });
  } catch (e) {
    console.error('POST /api/church-admin/signup:', e.code, e.message);
    res.status(500).json({ error: 'Signup failed.' });
  }
});

// POST /api/church-admin/login  (public)
// Body: { email, password }
// On approved → { admin_token, church }. Pending/rejected → 403 with status.
app.post('/api/church-admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const r = await db.query(`
      SELECT id, name, location, admin_email, admin_token, invite_code,
             password_hash, approval_status, rejected_reason
        FROM churches
       WHERE admin_email = $1
    `, [String(email).toLowerCase()]);
    if (!r.rows.length)
      return res.status(401).json({ error: 'No church admin account with this email.' });

    const row = r.rows[0];
    if (!row.password_hash) {
      // This is a manually-created church (pre-self-service). They never set a
      // password; fall back to the legacy admin_token-only flow.
      return res.status(403).json({
        error: 'no_password',
        message: 'This church was created by the main admin and does not use a password. Use the admin token they gave you (paste it on the church-admin page header).',
      });
    }

    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    if (row.approval_status === 'pending') {
      return res.status(403).json({
        error: 'pending',
        message: 'Your application is still under review. You will be able to sign in once the main admin approves it.',
      });
    }
    if (row.approval_status === 'rejected') {
      return res.status(403).json({
        error: 'rejected',
        message: row.rejected_reason
          ? `Application rejected: ${row.rejected_reason}`
          : 'Application rejected. Contact the main admin.',
      });
    }

    res.json({
      message: 'Signed in.',
      admin_token: row.admin_token,
      church: {
        id:           row.id,
        name:         row.name,
        location:     row.location,
        admin_email:  row.admin_email,
        invite_code:  row.invite_code,
      },
    });
  } catch (e) {
    console.error('POST /api/church-admin/login:', e.code, e.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ADMIN — REVIEW + APPROVE / REJECT CHURCH APPLICATIONS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/church-applications?status=pending   (default: pending)
// Returns the list of churches with the requested approval_status.
app.get('/api/admin/church-applications', adminAuth, async (req, res) => {
  const status = String(req.query.status || 'pending').toLowerCase();
  if (!['pending', 'approved', 'rejected', 'all'].includes(status))
    return res.status(400).json({ error: 'status must be pending|approved|rejected|all.' });
  try {
    const where  = status === 'all' ? '' : 'WHERE approval_status = $1';
    const params = status === 'all' ? [] : [status];
    const r = await db.query(`
      SELECT id, name, location, admin_email, contact_name, phone,
             invite_code, approval_status, approved_at, rejected_reason,
             rejected_at, created_at
        FROM churches
        ${where}
       ORDER BY created_at DESC
    `, params);
    res.json({ status, count: r.rows.length, applications: r.rows });
  } catch (e) {
    console.error('GET /api/admin/church-applications:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load applications.' });
  }
});

// POST /api/admin/church-applications/:id/approve
app.post('/api/admin/church-applications/:id/approve', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(`
      UPDATE churches
         SET approval_status = 'approved',
             approved_at     = NOW(),
             rejected_reason = NULL,
             rejected_at     = NULL
       WHERE id = $1
       RETURNING id, name, admin_email, contact_name, invite_code, admin_token, approval_status, approved_at
    `, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Application not found.' });
    const church = r.rows[0];

    // Best-effort email — never blocks or rolls back the approval.
    sendApprovalEmail(church, process.env.CHURCH_ADMIN_URL || null)
      .then((m) => { if (!m.ok) console.warn('[approve] email skipped:', m.error); })
      .catch((e) => console.warn('[approve] email error:', e.message));

    res.json({ message: 'Approved.', church });
  } catch (e) {
    console.error('POST /api/admin/church-applications/:id/approve:', e.code, e.message);
    res.status(500).json({ error: 'Approve failed.' });
  }
});

// POST /api/admin/church-applications/:id/reject  body: { reason }
app.post('/api/admin/church-applications/:id/reject', adminAuth, async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').trim() || null;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(`
      UPDATE churches
         SET approval_status = 'rejected',
             rejected_reason = $2,
             rejected_at     = NOW(),
             approved_at     = NULL
       WHERE id = $1
       RETURNING id, name, admin_email, contact_name, approval_status, rejected_reason, rejected_at
    `, [id, reason]);
    if (!r.rows.length) return res.status(404).json({ error: 'Application not found.' });
    const church = r.rows[0];

    sendRejectionEmail(church, reason)
      .then((m) => { if (!m.ok) console.warn('[reject] email skipped:', m.error); })
      .catch((e) => console.warn('[reject] email error:', e.message));

    res.json({ message: 'Rejected.', church });
  } catch (e) {
    console.error('POST /api/admin/church-applications/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Reject failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — REVIEW + APPROVE / REJECT TEACHER SIGNUPS
// All three endpoints use churchAuth, so a church admin signed in via
// x-church-key only sees / acts on teachers belonging to their own church.
// The master ADMIN_SECRET works too (super-admin sees everyone).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/church-admin/teachers?status=pending|approved|rejected|all
// Lists teachers in the caller's church filtered by approval status.
app.get('/api/church-admin/teachers', churchAuth, async (req, res) => {
  const status = String(req.query.status || 'pending').toLowerCase();
  if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
    return res.status(400).json({ error: 'status must be pending|approved|rejected|all.' });
  }
  const params = [];
  const where  = [`u.role = 'teacher'`];
  if (req.church) { params.push(req.church.id); where.push(`u.church_id = $${params.length}`); }
  if (status !== 'all') {
    params.push(status);
    where.push(`COALESCE(u.approval_status, 'approved') = $${params.length}`);
  }
  try {
    const r = await db.query(`
      SELECT
        u.id, u.email, u.full_name, u.created_at,
        COALESCE(u.approval_status, 'approved') AS approval_status,
        u.approved_at, u.rejected_at, u.rejected_reason,
        COALESCE(up.display_name, u.full_name)  AS display_name,
        COALESCE(up.avatar_emoji, '👤')         AS avatar_emoji,
        up.phone, up.location
      FROM users u
      LEFT JOIN user_profiles up ON up.email = u.email
      WHERE ${where.join(' AND ')}
      ORDER BY u.created_at DESC
    `, params);
    res.json({ status, count: r.rows.length, teachers: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/teachers:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load teachers.' });
  }
});

// POST /api/church-admin/teachers/:id/approve
app.post('/api/church-admin/teachers/:id/approve', churchAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  // Scope to the caller's church so a church admin can't approve someone
  // else's teachers.
  const params = [id];
  let scope = '';
  if (req.church) { params.push(req.church.id); scope = ` AND church_id = $${params.length}`; }
  try {
    const r = await db.query(`
      UPDATE users
         SET approval_status = 'approved',
             approved_at     = NOW(),
             approved_by_email = $${params.length + 1},
             rejected_reason = NULL,
             rejected_at     = NULL
       WHERE id = $1 AND role = 'teacher'${scope}
       RETURNING id, email, full_name, role, approval_status, approved_at
    `, [...params, req.church?.admin_email || null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Teacher not found in your church.' });
    res.json({ message: 'Approved.', teacher: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/teachers/:id/approve:', e.code, e.message);
    res.status(500).json({ error: 'Approve failed.' });
  }
});

// POST /api/church-admin/teachers/:id/reject  body: { reason }
app.post('/api/church-admin/teachers/:id/reject', churchAuth, async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').trim() || null;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const params = [id, reason];
  let scope = '';
  if (req.church) { params.push(req.church.id); scope = ` AND church_id = $${params.length}`; }
  try {
    const r = await db.query(`
      UPDATE users
         SET approval_status = 'rejected',
             rejected_reason = $2,
             rejected_at     = NOW(),
             approved_at     = NULL
       WHERE id = $1 AND role = 'teacher'${scope}
       RETURNING id, email, full_name, role, approval_status, rejected_reason, rejected_at
    `, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Teacher not found in your church.' });
    res.json({ message: 'Rejected.', teacher: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/teachers/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Reject failed.' });
  }
});

// Super-admin lists all churches (with member counts).
// admin_token is omitted by default; pass ?include=token to get it back.
// Even though this route is already adminAuth-gated, double-gating the token
// behind an explicit opt-in reduces accidental exposure (e.g. screenshots of
// the table that include the token column).
app.get('/api/admin/churches', adminAuth, async (req, res) => {
  const includeToken = req.query.include === 'token';
  // Self-service pending churches live on the Approvals page until reviewed,
  // and rejected ones shouldn't clutter the directory either. The Churches
  // page is the directory of *active* churches only. Pass ?status=all to
  // override (kept for diagnostics / future "show everything" toggle).
  const wantAll = req.query.status === 'all';
  try {
    const r = await db.query(`
      SELECT c.id, c.name, c.location, c.admin_email, c.invite_code, c.created_at,
             COALESCE(c.approval_status, 'approved') AS approval_status${includeToken ? ', c.admin_token' : ''},
             (SELECT COUNT(*) FROM users    WHERE church_id = c.id AND role = 'teacher') AS teachers,
             (SELECT COUNT(*) FROM classes  WHERE church_id = c.id)                       AS classes
        FROM churches c
       ${wantAll ? '' : "WHERE COALESCE(c.approval_status, 'approved') = 'approved'"}
       ORDER BY c.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List teachers, optionally filtered by church_id, or "?church=none" for
// teachers with NULL church_id (legacy accounts that registered before the
// church-aware flow). Used by the admin dashboard's Churches page so admins
// can spot orphaned teachers and assign them to a church.
app.get('/api/admin/teachers', adminAuth, async (req, res) => {
  const { church } = req.query;
  try {
    let sql = `
      SELECT u.id, u.email, u.full_name, u.church_id, u.created_at,
             c.name AS church_name,
             (SELECT COUNT(*) FROM classes WHERE teacher_email = u.email) AS classes,
             (SELECT MAX(awarded_at) FROM teacher_marks WHERE awarded_by = u.email) AS last_active
        FROM users u
        LEFT JOIN churches c ON c.id = u.church_id
       WHERE u.role = 'teacher'`;
    const params = [];
    if (church === 'none') {
      sql += ' AND u.church_id IS NULL';
    } else if (church) {
      params.push(church);
      sql += ` AND u.church_id = $${params.length}`;
    }
    sql += ' ORDER BY u.created_at DESC';
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign (or reassign) a teacher to a church. Master-admin only — church
// admins can't move teachers between churches. Also retro-stamps the
// teacher's existing classes/attendance/marks with the new church_id so
// admin insights pick them up immediately.
app.post('/api/admin/teachers/:email/assign', adminAuth, async (req, res) => {
  const { email } = req.params;
  const { church_id } = req.body || {};
  if (!church_id) return res.status(400).json({ error: 'church_id required.' });
  try {
    const u = await db.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND role=$2', [email, 'teacher']);
    if (!u.rows.length) return res.status(404).json({ error: 'Teacher not found.' });
    const c = await db.query('SELECT id FROM churches WHERE id = $1', [church_id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Church not found.' });

    await db.query('UPDATE users SET church_id = $1 WHERE LOWER(email) = LOWER($2)', [church_id, email]);
    // Backfill so historical data also rolls up to the assigned church.
    const cls   = await db.query('UPDATE classes        SET church_id = $1 WHERE LOWER(teacher_email) = LOWER($2) AND church_id IS DISTINCT FROM $1 RETURNING id', [church_id, email]);
    const att   = await db.query('UPDATE attendance     SET church_id = $1 WHERE LOWER(marked_by)     = LOWER($2) AND church_id IS DISTINCT FROM $1 RETURNING id', [church_id, email]);
    const marks = await db.query('UPDATE teacher_marks  SET church_id = $1 WHERE LOWER(awarded_by)    = LOWER($2) AND church_id IS DISTINCT FROM $1 RETURNING id', [church_id, email]);
    res.json({ ok: true, backfilled: { classes: cls.rowCount, attendance: att.rowCount, marks: marks.rowCount } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Church admin reads their own church info (for the dashboard banner).
// Identifies via x-church-key.
app.get('/api/church/me', churchAuth, (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  // Don't echo the admin_token back — it's already known to the caller and
  // logging it in network responses is needless exposure.
  const { admin_token, ...safe } = req.church;
  res.json(safe);
});

// Public lookup so teachers can validate a church code on the registration
// screen BEFORE submitting the form. Returns just the church name.
app.get('/api/church/by-code/:code', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, name, location FROM churches WHERE invite_code = $1',
      [req.params.code.toUpperCase()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown church code.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/categories', async (req, res) => {
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
  } catch (e) { res.status(500).json({ error:'Failed to fetch categories.' }); }
});

app.post('/api/admin/categories', adminAuth, async (req, res) => {
  const { id, label, description, color, icon, sort_order } = req.body;
  if (!id||!label) return res.status(400).json({ error:'id and label required.' });
  try {
    const r = await db.query(
      `INSERT INTO categories (id,label,description,color,icon,sort_order) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description,
         color=EXCLUDED.color, icon=EXCLUDED.icon, sort_order=EXCLUDED.sort_order RETURNING *`,
      [id, label, description||null, color||'#2563EB', icon||'📖', sort_order||0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:'Failed to save category.' }); }
});

app.post('/api/admin/category-translations', adminAuth, async (req, res) => {
  const { category_id, lang_code, label, description } = req.body;
  if (!category_id||!lang_code) return res.status(400).json({ error:'category_id and lang_code required.' });
  try {
    await db.query(`
      INSERT INTO category_translations (category_id,lang_code,label,description)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (category_id,lang_code) DO UPDATE
        SET label=EXCLUDED.label, description=EXCLUDED.description, updated_at=NOW()
    `, [category_id, lang_code, label||null, description||null]);
    res.json({ message:`Saved [${lang_code}] for category ${category_id}` });
  } catch (e) { res.status(500).json({ error:'Failed to save category translation.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGES & UI TRANSLATIONS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/languages', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT code,label,native_label,flag FROM languages WHERE is_active=TRUE ORDER BY label'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:'Failed to fetch languages.' }); }
});

app.get('/api/translations/:langCode', async (req, res) => {
  const { langCode } = req.params;
  try {
    const lc   = await db.query('SELECT code FROM languages WHERE code=$1 AND is_active=TRUE', [langCode]);
    const lang  = lc.rows.length ? langCode : 'en';
    const r     = await db.query('SELECT key,value FROM translations WHERE lang_code=$1', [lang]);
    const translations = {};
    r.rows.forEach(row => { translations[row.key] = row.value; });
    res.json({ lang, translations, count:r.rows.length });
  } catch (e) { res.status(500).json({ error:'Failed to fetch translations.' }); }
});

app.put('/api/translations', adminAuth, async (req, res) => {
  const { langCode, key, value } = req.body;
  if (!langCode||!key||value===undefined) return res.status(400).json({ error:'langCode, key, value required.' });
  try {
    await db.query(
      `INSERT INTO translations (lang_code,key,value) VALUES ($1,$2,$3)
       ON CONFLICT (lang_code,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [langCode, key, value]
    );
    res.json({ message:`Updated [${langCode}] ${key}` });
  } catch (e) { res.status(500).json({ error:'Failed to update translation.' }); }
});

// Seed all 70+ UI translation keys
app.post('/api/admin/translations/seed', adminAuth, async (req, res) => {
  const KEYS = [
    'good_morning','good_afternoon','good_evening','learner','health_tagline',
    'age_group','recent_lessons','recently_visited','quick_access','view_all',
    'start_quiz','no_lessons','loading',
    'notes','notes_sub','lessons','lessons_sub','language','language_sub',
    'devotional','devotional_sub',
    'cat_adult','cat_youth','cat_intermediate','cat_children',
    'cat_adult_range','cat_youth_range','cat_intermediate_range','cat_children_range',
    'tab_home','tab_lessons','tab_notes','tab_settings',
    'subscribe_title','subscribe_sub','plan_single','plan_all',
    'plan_single_tagline','plan_all_tagline','pay_now','select_plan',
    'select_category','pay_button','category_locked','category_locked_msg','upgrade',
    'settings','my_learning','progress_scores','quiz_results',
    'lesson_library','lesson_library_sub','lang_label','appearance',
    'dark_mode','light_mode','switch_theme','notifications','account',
    'edit_profile','edit_profile_sub','change_password','change_password_sub',
    'sign_out','sign_out_sub','delete_account','delete_account_sub',
    'about','about_app','website','reminderTime',
    'my_account','subscribed_category','subscription_details','plan_type',
    'status','expires_on','days_remaining','active','expired','renew','extend','your_plan',
    // ── Auto-injected app-wide UI keys ──
    'about_app_info','about_backend','about_built_with','about_contact','about_copyright','about_dept',
    'about_email','about_mission_body','about_our_mission','about_our_vision','about_vision_body','about_released','about_tagline','about_version',
    'about_website','account_active_n_days','account_active_one_day','account_all_age_groups','account_all_categories','account_badge_500_plan',
    'account_badge_all_access','account_category','account_email','account_extend_sub','account_full_access_note','account_n_days',
    'account_one_day','account_renew_sub','account_signout_device','account_signout_msg','account_signout_note','account_single',
    'account_single_plan_note','account_sub_expired','account_subscribe_now','account_subscribe_sub','account_upgrade_label','account_upgrade_sub',
    'account_zero_days','btn_cancel','btn_delete','btn_done','btn_not_now','btn_ok',
    'btn_retry','btn_save','bv_bible_tag','bv_could_not_load','bv_loading_ref','bv_try_again',
    'bv_verse_not_found','chpw_changed_msg','chpw_changed_title','chpw_confirm_label','chpw_confirm_placeholder','chpw_confirm_required',
    'chpw_current_label','chpw_current_placeholder','chpw_current_required','chpw_failed','chpw_info_card','chpw_new_label',
    'chpw_new_min','chpw_new_required','chpw_update_btn','cunits_adult_class','cunits_book_philemon','cunits_browse_units',
    'cunits_childrens_class','cunits_coming_soon','cunits_daily_devotional','cunits_default_theme','cunits_default_theme_sub','cunits_intermediate_class',
    'cunits_lessons_in_unit','cunits_loading_lessons','cunits_loading_units','cunits_no_lessons_in_unit','cunits_no_units_for','cunits_stat_quarter',
    'cunits_stat_units','cunits_subtitle_q4','cunits_tab_units','cunits_unit_n','cunits_units_of_study','cunits_youth_class',
    'delacc_confirm_password','delacc_delete_btn','delacc_delete_forever','delacc_deleted_msg','delacc_deleted_title','delacc_failed',
    'delacc_final_warning_msg','delacc_final_warning_title','delacc_irreversible','delacc_keep_account','delacc_not_logged_in','delacc_password_placeholder',
    'delacc_password_required','delacc_remove_intro','delacc_remove_item_1','delacc_remove_item_2','delacc_remove_item_3','delacc_remove_item_4',
    'dev_application','dev_clear','dev_clear_hl_msg','dev_clear_hl_title','dev_daily_devotional','dev_daily_reading_caps',
    'dev_devotional_content','dev_highlight','dev_highlighted_pill','dev_hl_section','dev_long_press_to_hl','dev_next',
    'dev_prayer','dev_previous','dev_reflection','dev_remove','dev_remove_hl','dev_remove_hl_q',
    'dev_save_section_q','dev_saved_highlights','dev_select_day','dev_todays_reading','err_network','fetch_failed_load',
    'fetch_loading','fetch_no_content','fetch_something_wrong','fetch_try_again','guard_access_all_4','guard_access_category',
    'guard_access_granted','guard_back_to_plans','guard_cannot_reach_server','guard_category_300','guard_check_connection','guard_checking_access',
    'guard_choose_category','guard_choose_category_sub','guard_choose_plan','guard_choose_plan_sub','guard_confirming_paystack','guard_continue_with',
    'guard_could_not_verify','guard_days','guard_expires_today','guard_feat_all_cats','guard_feat_best_value','guard_feat_devotionals',
    'guard_feat_languages','guard_feat_one_cat','guard_feat_quizzes','guard_header_sub','guard_header_title','guard_logout',
    'guard_n_days_left','guard_one_day_left','guard_pay_format','guard_payment_failed','guard_renew_btn','guard_standard',
    'guard_sub_activated','guard_sub_active','guard_tag_best_value','guard_tag_popular','guard_takes_few_seconds','guard_trust_instant',
    'guard_trust_paystack','guard_try_again','guard_try_again_msg','guard_unlock_all_300','guard_verifying_payment','guard_verifying_your_payment',
    'guard_youll_access_prefix','guard_youll_access_suffix','home_class_for','home_good_day','home_loading_lessons','home_locked_alert_msg',
    'home_locked_pill','home_no_recent','home_open_lesson_hint','home_recent_count_many','home_recent_count_one','home_selected',
    'home_start','home_subscribed','hymn_chorus','hymn_could_not_connect','hymn_ghb_number','hymn_gospel_hymn_book',
    'hymn_intro_verse','hymn_load_error','hymn_loading','hymn_next','hymn_no_n','hymn_not_found',
    'hymn_not_in_db','hymn_prev','hymn_verse_n','lesson_background','lesson_background_short','lesson_conclusion',
    'lesson_conclusion_short','lesson_daily_reading','lesson_discussion_questions','lesson_label','lesson_label_caps','lesson_loading',
    'lesson_memory_verse','lesson_next','lesson_notes_on_lesson','lesson_overview','lesson_part_num','lesson_prev',
    'lesson_quiz_completed','lesson_quiz_short','lesson_read_fullscreen','lesson_start_quiz','lesson_suggested_hymns','lesson_take_quiz_sub',
    'lesson_take_quiz_title','lesson_test_yourself','lesson_view','lesson_view_full_hymn','login_already_in_msg','login_already_in_title',
    'login_create_account','login_email_invalid','login_email_placeholder','login_email_required','login_failed','login_footer',
    'login_forgot','login_logout_other','login_or','login_password_placeholder','login_password_required','login_register',
    'login_reset_msg','login_reset_title','login_signin','login_signin_btn','login_sunday_school','login_welcome_back',
    'login_welcome_sub','notes_body_placeholder','notes_class_notes','notes_delete','notes_delete_confirm','notes_delete_title',
    'notes_device_only','notes_edit','notes_edit_note','notes_empty_sub','notes_empty_title','notes_new_button',
    'notes_new_note','notes_no_match_sub','notes_no_match_title','notes_note','notes_notes','notes_prefill_title',
    'notes_save_note','notes_search_placeholder','notes_stat_words','notes_title_placeholder','notes_untitled','notes_update_note',
    'notes_word','notes_words','notes_write_first','pay_all_access','pay_all_cats_full','pay_all_tagline',
    'pay_back_arrow','pay_change','pay_choose_plan','pay_continue_btn','pay_days','pay_days_from_today',
    'pay_email_help','pay_email_invalid','pay_email_required','pay_enter_email_title','pay_err_no_category','pay_err_no_plan',
    'pay_failed_title','pay_feat_all_cats','pay_feat_best_value','pay_feat_devotionals','pay_feat_languages','pay_feat_one_cat',
    'pay_feat_quizzes','pay_hero_badge','pay_hero_sub','pay_only_suffix','pay_opening_secure','pay_proceed_btn',
    'pay_row_category','pay_row_email','pay_row_expires','pay_row_plan','pay_row_standard','pay_secure_payment',
    'pay_select_age_category','pay_single_tagline','pay_success_note','pay_success_sub','pay_success_title','pay_tag_best_value',
    'pay_tag_popular','pay_topbar_subscribe','pay_trust_instant','pay_trust_paystack','pay_try_again','pay_verifying_sub',
    'pay_verifying_title','profile_church_label','profile_church_placeholder','profile_could_not_save','profile_display_name','profile_edit',
    'profile_location_label','profile_location_placeholder','profile_n_days_remaining','profile_no_subscription','profile_not_set','profile_personal_info',
    'profile_push_notifications','profile_push_sub','profile_save_failed','profile_subscription_status','profile_title','profile_toggle_theme',
    'progress_avg','progress_be_first','progress_best','progress_complete_quiz_msg','progress_completed','progress_cumulative_best',
    'progress_leaderboard','progress_lesson_completed_one','progress_lesson_scores','progress_lessons_completed','progress_my_progress','progress_my_scores',
    'progress_n_lessons_left','progress_no_quizzes','progress_no_scores','progress_one_lesson_left','progress_points','progress_rank',
    'progress_start_studying','progress_tab_progress','progress_tab_quiz','progress_tab_units','progress_top_learners','progress_you_suffix',
    'quiz_answer_all_n','quiz_excellent','quiz_keep_studying','quiz_lesson_quiz','quiz_loading','quiz_n_of_total_answered',
    'quiz_no_questions','quiz_pts','quiz_q_label','quiz_quiz_label','quiz_score_format','quiz_submit_answers',
    'quiz_well_done','register_btn','register_coming_soon','register_confirm_label','register_confirm_placeholder','register_confirm_required',
    'register_email_label','register_email_placeholder','register_failed','register_have_account','register_i_am_a','register_name_label',
    'register_name_placeholder','register_name_required','register_password_label','register_password_min','register_password_mismatch','register_password_placeholder',
    'register_pw_fair','register_pw_good','register_pw_strong','register_pw_weak','register_role_student','register_role_teacher',
    'register_soon_suffix','register_sub','register_teacher_restricted','register_title','set_active_badge','set_allow',
    'set_currently_selected','set_devotional_reminder','set_disabled','set_enable_notifications','set_enabled_at','set_fixed',
    'set_lang_english','set_lang_english_desc','set_lang_hausa','set_lang_hausa_desc','set_lang_igbo','set_lang_igbo_desc',
    'set_lang_yoruba','set_lang_yoruba_desc','set_my_profile','set_quiz_reminder','set_quiz_reminder_sub','set_signout_confirm',
    'set_tap_allow_reminders','set_version','teach_age_group_lbl','teach_attendance','teach_class','teach_class_caps',
    'teach_class_created_msg','teach_class_created_title','teach_class_name_lbl','teach_class_name_placeholder','teach_class_name_required','teach_classes',
    'teach_classes_caps','teach_create_class_btn','teach_create_first_class','teach_create_new_class','teach_dashboard_title','teach_description_lbl',
    'teach_description_placeholder','teach_error','teach_hero_book','teach_loading_classes','teach_mark_attendance','teach_mark_attendance_sub',
    'teach_my_classes','teach_new_class_btn','teach_no_classes_msg','teach_no_classes_yet','teach_progress','teach_students_caps',
    'teach_students_lbl','teach_tab_attend','teach_tab_classes','teach_tab_progress','teach_teacher_default','teach_teacher_tag',
    'teach_teacher_tools','teach_view_progress','teach_view_progress_sub','teach_welcome_back','tmark_absent','tmark_answered_question',
    'tmark_bonus_points','tmark_memory_verse','tmark_present','tmark_pts_awarded','unit_n_lessons','unit_one_lesson',
    'units_count','units_quarter_period','units_theme_main','units_theme_prefix','units_theme_sub',
    // ── Homescreen banner titles ──
    'home_banner_quarter_title','home_banner_quarter_sub','home_banner_devotionals_title','home_banner_devotionals_sub',
    'home_banner_quiz_title','home_banner_quiz_sub','home_banner_leaderboard_title','home_banner_leaderboard_sub',
  ];
  const EN = {
    good_morning:'Good morning', good_afternoon:'Good afternoon', good_evening:'Good evening',
    learner:'Learner', health_tagline:'Your learning journey continues today.',
    age_group:'Age Group', recent_lessons:'Recent Lessons', recently_visited:'Recently Visited',
    quick_access:'Quick Actions', view_all:'View All →', start_quiz:'Start Quiz',
    no_lessons:'No lessons yet', loading:'Loading…',
    notes:'Notes', notes_sub:'Your class notes',
    lessons:'Lessons', lessons_sub:'Browse all units',
    language:'Language', language_sub:'EN · YO · IG · HA',
    devotional:'Devotional', devotional_sub:'Daily reading plan',
    cat_adult:'Adult', cat_youth:'Youth', cat_intermediate:'Intermediate', cat_children:'Children',
    cat_adult_range:'26 & above', cat_youth_range:'Ages 18 – 25',
    cat_intermediate_range:'Ages 12 – 17', cat_children_range:'Ages 4 – 11',
    tab_home:'Home', tab_lessons:'Lessons', tab_notes:'Notes', tab_settings:'Settings',
    subscribe_title:'Subscribe to Unlock', subscribe_sub:'Choose a plan to access your lessons',
    plan_single:'Single Category', plan_all:'All Categories',
    plan_single_tagline:'One age group of your choice', plan_all_tagline:'Every age group unlocked',
    pay_now:'Subscribe Now', select_plan:'Select a plan above',
    select_category:'Select a category above', pay_button:'Pay',
    category_locked:'Category Locked',
    category_locked_msg:'Your plan only covers your selected category.',
    upgrade:'Upgrade to All Categories',
    settings:'Settings', my_learning:'My Learning',
    progress_scores:'Progress & Scores', quiz_results:'Quiz results and stats',
    lesson_library:'Lesson Library', lesson_library_sub:'Browse all Sunday School lessons',
    lang_label:'Language', appearance:'Appearance', dark_mode:'Dark Mode', light_mode:'Light Mode',
    switch_theme:'Switch app theme', notifications:'Notifications', account:'Account',
    edit_profile:'Edit Profile', edit_profile_sub:'Name, avatar, church',
    change_password:'Change Password', change_password_sub:'Update your login password',
    sign_out:'Sign Out', sign_out_sub:'Sign out of this device',
    delete_account:'Delete Account', delete_account_sub:'Permanently remove data',
    about:'About', about_app:'About App', website:'Website', reminderTime:'REMINDER TIME',
    my_account:'My Account', subscribed_category:'Subscribed Category',
    subscription_details:'Subscription Details', plan_type:'Plan Type',
    status:'Status', expires_on:'Expires On', days_remaining:'Days Remaining',
    active:'Active', expired:'Expired', renew:'Renew Subscription',
    extend:'Extend Subscription', your_plan:'Your Plan',
    // ── Auto-injected app-wide UI keys ──
    about_app_info: 'APP INFORMATION',
    about_backend: 'BACKEND',
    about_built_with: 'BUILT WITH',
    about_contact: 'CONTACT',
    about_copyright: '© 2026 GOFAMINT Sunday School Department\nAll rights reserved.',
    about_dept: 'Sunday School Department',
    about_email: 'EMAIL',
    about_mission_body: 'GOFAMINT Sunday School is dedicated to providing quality, biblically-sound lessons that equip members of all ages for Christian living. Our app brings the Sunday School experience to your fingertips — anytime, anywhere.',
    about_our_mission: 'Our Mission',
    about_our_vision:  'Our Vision',
    about_vision_body: 'To raise a generation of believers grounded in scripture, equipped to live out their faith with confidence and conviction — and to make the depth of Sunday School teaching accessible to every member of our church family, in every language they speak, on every device they own.',
    about_released: 'RELEASED',
    about_tagline: 'Empowering believers through systematic Bible study and spiritual formation.',
    about_version: 'VERSION',
    about_website: 'WEBSITE',
    account_active_n_days: 'Active · {n} days remaining',
    account_active_one_day: 'Active · 1 day remaining',
    account_all_age_groups: 'All age groups',
    account_all_categories: 'All Categories',
    account_badge_500_plan: '₦500 Plan',
    account_badge_all_access: 'All Access',
    account_category: 'Category',
    account_email: 'Email',
    account_extend_sub: '{n} days left — top up now',
    account_full_access_note: 'Full access to all 4 age groups.',
    account_n_days: '{n} days',
    account_one_day: '1 day',
    account_renew_sub: 'Reactivate your access · from ₦500',
    account_signout_device: 'Sign Out of This Device',
    account_signout_msg: 'This will sign you out from this device. Your subscription stays active and can be restored by logging in again.',
    account_signout_note: 'Signing out removes local data only. Your subscription remains active and can be restored by logging in again.',
    account_single: 'Single',
    account_single_plan_note: 'Single category plan · Upgrade to unlock all.',
    account_sub_expired: 'Subscription expired',
    account_subscribe_now: 'Subscribe Now',
    account_subscribe_sub: 'From ₦500 · Choose your category',
    account_upgrade_label: 'Upgrade to All Categories',
    account_upgrade_sub: 'Unlock every age group · ₦1,000',
    account_zero_days: '0 days',
    btn_cancel: 'Cancel',
    btn_delete: 'Delete',
    btn_done: 'Done',
    btn_not_now: 'Not now',
    btn_ok: 'OK',
    btn_retry: 'Retry',
    btn_save: 'Save',
    bv_bible_tag: 'BIBLE',
    bv_could_not_load: 'Could not load verse.',
    bv_loading_ref: 'Loading {ref}…',
    bv_try_again: 'Try again',
    bv_verse_not_found: 'Verse not found',
    chpw_changed_msg: 'Your password has been updated successfully.',
    chpw_changed_title: '✅ Password Changed',
    chpw_confirm_label: 'CONFIRM PASSWORD',
    chpw_confirm_placeholder: 'Re-enter new password',
    chpw_confirm_required: 'Confirm your new password.',
    chpw_current_label: 'CURRENT PASSWORD',
    chpw_current_placeholder: 'Enter current password',
    chpw_current_required: 'Enter your current password.',
    chpw_failed: 'Failed.',
    chpw_info_card: '🔐  For your security, enter your current password first before setting a new one.',
    chpw_new_label: 'NEW PASSWORD',
    chpw_new_min: 'Must be at least 6 characters.',
    chpw_new_required: 'Enter a new password.',
    chpw_update_btn: 'Update Password  →',
    cunits_adult_class: 'Adult Class',
    cunits_book_philemon: 'Book of Philemon',
    cunits_browse_units: 'Browse Units →',
    cunits_childrens_class: 'Children\'s Class',
    cunits_coming_soon: 'Content may be coming soon.',
    cunits_daily_devotional: 'Daily Devotional',
    cunits_default_theme: 'Demonstration of the Christian Life',
    cunits_default_theme_sub: 'Exposition on the Book of Philemon',
    cunits_intermediate_class: 'Intermediate Class',
    cunits_lessons_in_unit: 'LESSONS IN THIS UNIT',
    cunits_loading_lessons: 'Loading lessons…',
    cunits_loading_units: 'Loading units…',
    cunits_no_lessons_in_unit: 'No lessons in this unit yet.',
    cunits_no_units_for: 'No units found for {label}.',
    cunits_stat_quarter: 'Quarter',
    cunits_stat_units: 'Units',
    cunits_subtitle_q4: 'Sunday School · Q4 2026',
    cunits_tab_units: 'Units',
    cunits_unit_n: 'Unit {n}',
    cunits_units_of_study: 'Units of Study',
    cunits_youth_class: 'Youth Class',
    delacc_confirm_password: 'CONFIRM YOUR PASSWORD',
    delacc_delete_btn: '🗑️  Delete My Account Forever',
    delacc_delete_forever: 'Delete Forever',
    delacc_deleted_msg: 'Your account has been permanently deleted.',
    delacc_deleted_title: 'Account Deleted',
    delacc_failed: 'Failed to delete account.',
    delacc_final_warning_msg: 'This will permanently delete your account, all quiz scores, and profile data. There is no way to recover this.',
    delacc_final_warning_title: '⚠️ Final Warning',
    delacc_irreversible: 'This action is irreversible',
    delacc_keep_account: 'Cancel — Keep My Account',
    delacc_not_logged_in: 'Not logged in.',
    delacc_password_placeholder: 'Enter your password to confirm',
    delacc_password_required: 'Please enter your password to confirm.',
    delacc_remove_intro: 'Deleting your account will permanently remove:',
    delacc_remove_item_1: '• Your account and login credentials',
    delacc_remove_item_2: '• All quiz scores and progress',
    delacc_remove_item_3: '• Your profile and preferences',
    delacc_remove_item_4: '• Your position on the leaderboard',
    dev_application: 'Application',
    dev_clear: 'Clear',
    dev_clear_hl_msg: 'Remove all?',
    dev_clear_hl_title: 'Clear Highlights',
    dev_daily_devotional: 'Daily Devotional',
    dev_daily_reading_caps: 'DAILY DEVOTIONAL READING',
    dev_devotional_content: 'Devotional Content',
    dev_highlight: 'Highlight',
    dev_highlighted_pill: '✎ Highlighted',
    dev_hl_section: 'Highlight Section',
    dev_long_press_to_hl: 'Long-press to highlight',
    dev_next: 'Next ›',
    dev_prayer: 'Prayer',
    dev_previous: '‹ Previous',
    dev_reflection: 'Reflection',
    dev_remove: 'Remove',
    dev_remove_hl: 'Remove Highlight',
    dev_remove_hl_q: 'Remove this highlight?',
    dev_save_section_q: 'Save this section?',
    dev_saved_highlights: 'Saved Highlights',
    dev_select_day: 'Select Day',
    dev_todays_reading: 'Today\'s Reading',
    err_network: 'Network error. Please check your connection.',
    fetch_failed_load: 'Failed to load data. Please check your connection and try again.',
    fetch_loading: 'Loading...',
    fetch_no_content: 'No content found.',
    fetch_something_wrong: 'Something went wrong',
    fetch_try_again: 'Try Again',
    guard_access_all_4: 'You now have access to all 4 categories!',
    guard_access_category: 'You now have access to the {label} category!',
    guard_access_granted: 'Access Granted! 🎉',
    guard_back_to_plans: '← Back to plans',
    guard_cannot_reach_server: 'Cannot Reach Server',
    guard_category_300: 'Category: {label} · 300 days',
    guard_check_connection: 'Check your internet connection and ensure the app server is running.',
    guard_checking_access: 'Checking your access…',
    guard_choose_category: 'Choose your category',
    guard_choose_category_sub: 'You\'ll only have access to this age group with the ₦500 plan',
    guard_choose_plan: 'Choose your plan',
    guard_choose_plan_sub: 'Select a subscription that works for you',
    guard_confirming_paystack: 'Confirming with Paystack…',
    guard_continue_with: 'Continue with {price}  →',
    guard_could_not_verify: 'We couldn\'t verify your payment. Please try again.',
    guard_days: 'days',
    guard_expires_today: 'Subscription expires today!',
    guard_feat_all_cats: 'All 4 categories',
    guard_feat_best_value: '🎁 Best value',
    guard_feat_devotionals: '📅 Daily devotionals',
    guard_feat_languages: '🌐 4-language support',
    guard_feat_one_cat: '1 category (your choice)',
    guard_feat_quizzes: '⚡ Lesson quizzes',
    guard_header_sub: 'Subscribe to unlock your content',
    guard_header_title: 'GOFAMINT Sunday School',
    guard_logout: '🚪  Log out',
    guard_n_days_left: '{n} days left — tap to renew',
    guard_one_day_left: '1 day left — tap to renew',
    guard_pay_format: 'Pay {price} — {label}  →',
    guard_payment_failed: 'Payment Failed',
    guard_renew_btn: 'Renew',
    guard_standard: 'Standard',
    guard_sub_activated: 'Subscription Activated!',
    guard_sub_active: 'Your subscription is now active',
    guard_tag_best_value: 'BEST VALUE',
    guard_tag_popular: 'POPULAR',
    guard_takes_few_seconds: 'This usually takes a few seconds.',
    guard_trust_instant: '⚡ Instant access',
    guard_trust_paystack: '🔒 Paystack secured',
    guard_try_again: 'Try Again',
    guard_try_again_msg: 'Please try again',
    guard_unlock_all_300: 'Unlocking all categories · 300 days',
    guard_verifying_payment: 'Verifying payment…',
    guard_verifying_your_payment: 'Verifying your payment…',
    guard_youll_access_prefix: 'You\'ll access ',
    guard_youll_access_suffix: ' content only',
    home_class_for: '{label} Class',
    home_good_day: 'Good day 👋',
    home_loading_lessons: 'Loading lessons…',
    home_locked_alert_msg: 'Your ₦500 plan only unlocks the {label} category. Upgrade to All Categories (₦1,000) to access {target}.',
    home_locked_pill: '🔒  Locked',
    home_no_recent: 'No recently visited lessons yet.',
    home_open_lesson_hint: 'Open a lesson and it will appear here.',
    home_recent_count_many: 'Showing your last {n} visited lessons',
    home_recent_count_one: 'Showing your last visited lesson',
    home_selected: 'Selected',
    home_start: 'Start →',
    home_subscribed: 'subscribed',
    hymn_chorus: 'CHORUS',
    hymn_could_not_connect: 'Could not connect to server. Check your network.',
    hymn_ghb_number: 'G.H.B. No. {n}',
    hymn_gospel_hymn_book: 'Gospel Hymn Book',
    hymn_intro_verse: 'Sing to the Lord a new song; sing to the Lord, all the earth. — Psalm 96:1',
    hymn_load_error: 'Could not load hymn',
    hymn_loading: 'Loading hymns…',
    hymn_next: 'Next →',
    hymn_no_n: 'No. {n}',
    hymn_not_found: 'Hymn not found',
    hymn_not_in_db: 'This number isn\'t in the database yet.',
    hymn_prev: '← Prev',
    hymn_verse_n: 'Verse {n}',
    lesson_background: 'Lesson Background',
    lesson_background_short: 'Background',
    lesson_conclusion: 'Lesson Conclusion',
    lesson_conclusion_short: 'Conclusion',
    lesson_daily_reading: 'Daily\nReading',
    lesson_discussion_questions: 'Discussion Questions',
    lesson_label: 'Lesson',
    lesson_label_caps: 'LESSON',
    lesson_loading: 'Loading lesson…',
    lesson_memory_verse: 'Memory Verse',
    lesson_next: 'Next ›',
    lesson_notes_on_lesson: 'Notes on the Lesson',
    lesson_overview: 'Lesson Overview',
    lesson_part_num: 'PART {n}',
    lesson_prev: '‹ Prev',
    lesson_quiz_completed: 'Quiz Completed',
    lesson_quiz_short: 'Quiz',
    lesson_read_fullscreen: 'Read Full Screen',
    lesson_start_quiz: 'Start Quiz',
    lesson_suggested_hymns: 'Suggested Hymns',
    lesson_take_quiz_sub: 'Earn points and track your progress',
    lesson_take_quiz_title: 'Take the Lesson Quiz',
    lesson_test_yourself: 'Test Yourself',
    lesson_view: 'View →',
    lesson_view_full_hymn: 'View Full Hymn',
    login_already_in_msg: 'This account is currently active on another device.\n\nContinuing will immediately log that device out.',
    login_already_in_title: '⚠️ Already Logged In',
    login_create_account: 'Create an account',
    login_email_invalid: 'Enter a valid email.',
    login_email_placeholder: 'Email address',
    login_email_required: 'Email is required.',
    login_failed: 'Login failed. Please try again.',
    login_footer: '© GOFAMINT Sunday School Department',
    login_forgot: 'Forgot password?',
    login_logout_other: 'Log Out Other Device',
    login_or: 'or',
    login_password_placeholder: 'Password',
    login_password_required: 'Password is required.',
    login_register: 'Register',
    login_reset_msg: 'Contact your administrator to reset your password.',
    login_reset_title: 'Reset Password',
    login_signin: 'Sign In',
    login_signin_btn: 'Sign In  →',
    login_sunday_school: 'Sunday School',
    login_welcome_back: 'Welcome back',
    login_welcome_sub: 'Sign in to continue your learning journey',
    notes_body_placeholder: 'Write what you learned in class today…',
    notes_class_notes: 'Class Notes',
    notes_delete: '🗑 Delete',
    notes_delete_confirm: 'Delete this note permanently?',
    notes_delete_title: 'Delete Note',
    notes_device_only: 'Notes are saved on this device only',
    notes_edit: '✏️ Edit',
    notes_edit_note: 'Edit Note',
    notes_empty_sub: 'Write down what you learn in class. Your notes are saved privately on this device.',
    notes_empty_title: 'No notes yet',
    notes_new_button: '+ New',
    notes_new_note: 'New Note',
    notes_no_match_sub: 'Try a different search term.',
    notes_no_match_title: 'No matching notes',
    notes_note: 'note',
    notes_notes: 'notes',
    notes_prefill_title: 'Notes — {lesson}',
    notes_save_note: 'Save Note',
    notes_search_placeholder: 'Search notes…',
    notes_stat_words: 'Words',
    notes_title_placeholder: 'Note title…',
    notes_untitled: 'Untitled Note',
    notes_update_note: 'Update Note',
    notes_word: 'word',
    notes_words: 'words',
    notes_write_first: 'Write Your First Note',
    pay_all_access: 'All Access',
    pay_all_cats_full: 'All Categories (Full Access)',
    pay_all_tagline: 'Access every age group',
    pay_back_arrow: '‹ Back',
    pay_change: 'Change',
    pay_choose_plan: 'CHOOSE YOUR PLAN',
    pay_continue_btn: 'Continue to Payment →',
    pay_days: 'days',
    pay_days_from_today: 'days from today',
    pay_email_help: 'Your subscription will be linked to this email. Use the same email to restore access on any device.',
    pay_email_invalid: 'Enter a valid email address.',
    pay_email_required: 'Please enter your email.',
    pay_enter_email_title: 'Enter Your Email',
    pay_err_no_category: 'Please select an age category for your plan.',
    pay_err_no_plan: 'Please choose a subscription plan.',
    pay_failed_title: 'Payment Failed',
    pay_feat_all_cats: 'All 4 categories',
    pay_feat_best_value: '🎁 Best value',
    pay_feat_devotionals: '📅 Daily devotionals',
    pay_feat_languages: '🌐 4-language support',
    pay_feat_one_cat: 'One category of your choice',
    pay_feat_quizzes: '⚡ Lesson quizzes',
    pay_hero_badge: '🔒  Secured by Paystack  ·  Instant Activation',
    pay_hero_sub: 'Sunday School · Digital Access',
    pay_only_suffix: 'Only',
    pay_opening_secure: 'Opening secure payment...',
    pay_proceed_btn: 'Proceed to Payment →',
    pay_row_category: 'Category',
    pay_row_email: 'Email',
    pay_row_expires: 'Expires',
    pay_row_plan: 'Plan',
    pay_row_standard: 'Standard',
    pay_secure_payment: 'Secure Payment',
    pay_select_age_category: 'SELECT YOUR AGE CATEGORY',
    pay_single_tagline: 'Access one age group',
    pay_success_note: 'The app will open automatically. Enjoy your studies! 🕊️',
    pay_success_sub: 'Your subscription is now active. Welcome to GOFAMINT Sunday School!',
    pay_success_title: 'Access Granted!',
    pay_tag_best_value: 'BEST VALUE',
    pay_tag_popular: 'POPULAR',
    pay_topbar_subscribe: 'Subscribe',
    pay_trust_instant: 'Instant Activation',
    pay_trust_paystack: 'Secured by Paystack',
    pay_try_again: 'Try Again',
    pay_verifying_sub: 'Please wait while we confirm your payment and activate your subscription.',
    pay_verifying_title: 'Verifying your payment...',
    profile_church_label: 'Church / Assembly',
    profile_church_placeholder: 'Church name',
    profile_could_not_save: 'Could not save.',
    profile_display_name: 'Display name',
    profile_edit: 'Edit',
    profile_location_label: 'Location',
    profile_location_placeholder: 'City, Country',
    profile_n_days_remaining: '{n} days remaining',
    profile_no_subscription: 'No active subscription',
    profile_not_set: 'Not set',
    profile_personal_info: 'PERSONAL INFO',
    profile_push_notifications: 'Push Notifications',
    profile_push_sub: 'Lesson reminders and updates',
    profile_save_failed: 'Save Failed',
    profile_subscription_status: 'Subscription Status',
    profile_title: 'Profile & Settings',
    profile_toggle_theme: 'Toggle app theme',
    progress_avg: 'avg',
    progress_be_first: 'Be the first to complete a quiz!',
    progress_best: 'Best',
    progress_complete_quiz_msg: 'Complete a lesson quiz to see your scores.',
    progress_completed: 'Completed',
    progress_cumulative_best: 'Cumulative best scores',
    progress_leaderboard: 'Leaderboard',
    progress_lesson_completed_one: 'lesson completed',
    progress_lesson_scores: 'Lesson Scores',
    progress_lessons_completed: 'lessons completed',
    progress_my_progress: 'My Progress',
    progress_my_scores: 'My Scores',
    progress_n_lessons_left: '{n} more lessons remaining — keep going!',
    progress_no_quizzes: 'No quizzes yet',
    progress_no_scores: 'No scores yet',
    progress_one_lesson_left: '1 more lesson remaining — keep going!',
    progress_points: 'Points',
    progress_rank: 'Rank',
    progress_start_studying: 'Start Studying',
    progress_tab_progress: 'Progress',
    progress_tab_quiz: 'Quiz',
    progress_tab_units: 'Units',
    progress_top_learners: 'Top Learners',
    progress_you_suffix: '(You)',
    quiz_answer_all_n: 'Answer all {n} questions',
    quiz_excellent: 'Excellent! 🎉',
    quiz_keep_studying: 'Keep studying! 💪',
    quiz_lesson_quiz: 'Lesson Quiz',
    quiz_loading: 'Loading questions…',
    quiz_n_of_total_answered: '{n} of {total} answered',
    quiz_no_questions: 'No quiz questions yet for this lesson.',
    quiz_pts: 'pts',
    quiz_q_label: 'Q',
    quiz_quiz_label: 'Quiz',
    quiz_score_format: '{score} / {max} points',
    quiz_submit_answers: 'Submit Answers →',
    quiz_well_done: 'Well done! ✓',
    register_btn: 'Create Account  →',
    register_coming_soon: 'Coming Soon',
    register_confirm_label: 'Confirm Password',
    register_confirm_placeholder: 'Re-enter password',
    register_confirm_required: 'Please confirm your password.',
    register_email_label: 'Email Address',
    register_email_placeholder: 'you@example.com',
    register_failed: 'Registration failed.',
    register_have_account: 'Already have an account?',
    register_i_am_a: 'I AM A',
    register_name_label: 'Full Name',
    register_name_placeholder: 'Your full name',
    register_name_required: 'Full name is required.',
    register_password_label: 'Password',
    register_password_min: 'Password must be at least 6 characters.',
    register_password_mismatch: 'Passwords do not match.',
    register_password_placeholder: 'Min. 6 characters',
    register_pw_fair: 'Fair',
    register_pw_good: 'Good',
    register_pw_strong: 'Strong',
    register_pw_weak: 'Weak',
    register_role_student: 'Student',
    register_role_teacher: 'Teacher',
    register_soon_suffix: '(Soon)',
    register_sub: 'Join thousands learning God\'s word daily',
    register_teacher_restricted: 'Teacher registration is currently restricted.',
    register_title: 'Create account',
    set_active_badge: 'ACTIVE',
    set_allow: 'Allow',
    set_currently_selected: 'Currently selected language',
    set_devotional_reminder: 'Devotional Reminder',
    set_disabled: 'Disabled',
    set_enable_notifications: 'Enable Notifications',
    set_enabled_at: 'Enabled · {time}',
    set_fixed: '🔒 Fixed',
    set_lang_english: 'English',
    set_lang_english_desc: 'Default app language',
    set_lang_hausa: 'Hausa',
    set_lang_hausa_desc: 'Northern Nigeria',
    set_lang_igbo: 'Igbo',
    set_lang_igbo_desc: 'South-east Nigeria',
    set_lang_yoruba: 'Yoruba',
    set_lang_yoruba_desc: 'South-west Nigeria',
    set_my_profile: 'My Profile',
    set_quiz_reminder: 'Sunday School Quiz Reminder',
    set_quiz_reminder_sub: 'Every Sunday · 3:00 PM · automatically scheduled',
    set_signout_confirm: 'Are you sure?',
    set_tap_allow_reminders: 'Tap to allow lesson reminders',
    set_version: 'Version 1.0.0 · GOFAMINT',
    teach_age_group_lbl: 'AGE GROUP',
    teach_attendance: 'Attendance',
    teach_class: 'Class',
    teach_class_caps: 'CLASS',
    teach_class_created_msg: 'Invite code: {code}\nShare this with your students.',
    teach_class_created_title: 'Class Created! 🎉',
    teach_class_name_lbl: 'CLASS NAME',
    teach_class_name_placeholder: 'e.g. Sunday Morning Adults',
    teach_class_name_required: 'Class name is required.',
    teach_classes: 'Classes',
    teach_classes_caps: 'CLASSES',
    teach_create_class_btn: 'Create Class',
    teach_create_first_class: 'Create First Class',
    teach_create_new_class: 'Create New Class',
    teach_dashboard_title: 'Teacher Dashboard',
    teach_description_lbl: 'DESCRIPTION (optional)',
    teach_description_placeholder: 'Brief description...',
    teach_error: 'Error',
    teach_hero_book: 'Manage classes · Mark attendance · Award points',
    teach_loading_classes: 'Loading classes…',
    teach_mark_attendance: 'Mark Attendance',
    teach_mark_attendance_sub: 'Record who was present today',
    teach_my_classes: 'My Classes',
    teach_new_class_btn: '+  New Class',
    teach_no_classes_msg: 'Create your first class and share the invite code with your students.',
    teach_no_classes_yet: 'No classes yet',
    teach_progress: 'Progress',
    teach_students_caps: 'STUDENTS',
    teach_students_lbl: 'students',
    teach_tab_attend: 'Attend',
    teach_tab_classes: 'Classes',
    teach_tab_progress: 'Progress',
    teach_teacher_default: 'Teacher',
    teach_teacher_tag: 'TEACHER',
    teach_teacher_tools: '📋  TEACHER TOOLS',
    teach_view_progress: 'View Progress',
    teach_view_progress_sub: 'Leaderboard & attendance heatmap',
    teach_welcome_back: 'Welcome back,',
    tmark_absent: 'Absent',
    tmark_answered_question: 'Answered Question',
    tmark_bonus_points: 'Bonus Points',
    tmark_memory_verse: 'Memory Verse',
    tmark_present: '✓ Present',
    tmark_pts_awarded: '+{n} pts awarded',
    unit_n_lessons: '{n} Lessons',
    unit_one_lesson: '1 Lesson',
    units_count: '{n} Units',
    units_quarter_period: '4TH QUARTER  •  JUNE – AUG 2023',
    units_theme_main: 'CHRISTIAN LIFE',
    units_theme_prefix: 'Demonstration of the',
    units_theme_sub: 'EXPOSITION ON THE BOOK OF PHILEMON',
    // ── Homescreen banner titles ──
    home_banner_quarter_title:     'Q4 2026 Quarter',
    home_banner_quarter_sub:       'Exposition on Philemon',
    home_banner_devotionals_title: 'Daily Devotionals',
    home_banner_devotionals_sub:   'Read & grow each morning',
    home_banner_quiz_title:        'Quiz Challenge',
    home_banner_quiz_sub:          'Earn points this week',
    home_banner_leaderboard_title: 'Leaderboard',
    home_banner_leaderboard_sub:   'See where you rank',
  };
  try {
    for (const key of KEYS) {
      await db.query(
        `INSERT INTO translations (lang_code,key,value) VALUES ('en',$1,$2)
         ON CONFLICT (lang_code,key) DO NOTHING`, [key, EN[key]||key]
      );
    }
    for (const lang of ['yo','ig','ha']) {
      for (const key of KEYS) {
        await db.query(
          `INSERT INTO translations (lang_code,key,value) VALUES ($1,$2,'')
           ON CONFLICT (lang_code,key) DO NOTHING`, [lang, key]
        );
      }
    }
    res.json({ message:`Seeded ${KEYS.length} keys for en/yo/ig/ha`, keys:KEYS.length });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/category-language/:categoryId', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT lang_code FROM category_languages WHERE category_id=$1', [req.params.categoryId]
    );
    res.json({ categoryId:req.params.categoryId, langCode:r.rows[0]?.lang_code||'en' });
  } catch (e) { res.status(500).json({ error:'Failed to fetch category language.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNITS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/units', async (req, res) => {
  const { category, lang='en' } = req.query;
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
  } catch (e) { res.status(500).json({ error:'Failed to fetch units.' }); }
});

app.get('/api/admin/units/:id', adminAuth, async (req, res) => {
  try {
    const unit  = await db.query('SELECT * FROM units WHERE id=$1', [req.params.id]);
    if (!unit.rows.length) return res.status(404).json({ error:'Unit not found.' });
    const trans = await db.query('SELECT * FROM unit_translations WHERE unit_id=$1', [req.params.id]);
    const translations = {};
    trans.rows.forEach(t => {
      translations[t.lang_code] = { title:t.title, description:t.description, lesson_range:t.lesson_range };
    });
    res.json({ ...unit.rows[0], translations });
  } catch (e) { res.status(500).json({ error:'Failed to fetch unit.' }); }
});

async function saveUnitTranslations(unitId, translations) {
  for (const lang of ['en','yo','ig','ha']) {
    const t = translations[lang];
    if (!t) continue;
    await db.query(`
      INSERT INTO unit_translations (unit_id,lang_code,title,description,lesson_range)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (unit_id,lang_code) DO UPDATE
        SET title=EXCLUDED.title, description=EXCLUDED.description,
            lesson_range=EXCLUDED.lesson_range, updated_at=NOW()
    `, [unitId, lang, t.title||null, t.description||null, t.lesson_range||null]);
  }
}

app.post('/api/admin/units', adminAuth, async (req, res) => {
  const { id, category_id, title, description, lesson_range, color, sort_order, translations={} } = req.body;
  if (!id||!title||!category_id) return res.status(400).json({ error:'id, category_id, title required.' });
  try {
    const r = await db.query(
      `INSERT INTO units (id,category_id,title,description,lesson_range,color,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET category_id=EXCLUDED.category_id, title=EXCLUDED.title,
         description=EXCLUDED.description, lesson_range=EXCLUDED.lesson_range,
         color=EXCLUDED.color, sort_order=EXCLUDED.sort_order RETURNING *`,
      [id, category_id, title, description||null, lesson_range||null, color||null, sort_order||1]
    );
    await saveUnitTranslations(id, translations);
    res.status(201).json({ ...r.rows[0], translations });
  } catch (e) { console.error('admin/units POST:', e.message); res.status(500).json({ error:'Failed to save unit.' }); }
});

app.put('/api/admin/units/:id', adminAuth, async (req, res) => {
  const { category_id, title, description, lesson_range, color, sort_order, translations={} } = req.body;
  if (!title) return res.status(400).json({ error:'title required.' });
  try {
    const r = await db.query(
      `UPDATE units SET category_id=COALESCE($1,category_id), title=$2, description=$3,
         lesson_range=$4, color=$5, sort_order=$6 WHERE id=$7 RETURNING *`,
      [category_id||null, title, description||null, lesson_range||null, color||null, sort_order||1, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Unit not found.' });
    await saveUnitTranslations(req.params.id, translations);
    res.json({ ...r.rows[0], translations });
  } catch (e) { res.status(500).json({ error:'Failed to update unit.' }); }
});

app.delete('/api/admin/units/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM units WHERE id=$1', [req.params.id]);
    res.json({ message:'Unit deleted.' });
  } catch (e) { res.status(500).json({ error:'Failed to delete unit.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LESSONS — helpers
// ─────────────────────────────────────────────────────────────────────────────
function mergeLesson(row) {
  const safeJson = v => {
    if (Array.isArray(v)) return v;
    if (typeof v==='string') { try { return JSON.parse(v); } catch(_){} }
    return [];
  };
  const lesson_part     = safeJson(row.trans_part).length  ? safeJson(row.trans_part)  : safeJson(row.base_part);
  const devotional_days = safeJson(row.trans_days).length  ? safeJson(row.trans_days)  : safeJson(row.base_days);
  const questions       = safeJson(row.trans_q).length     ? safeJson(row.trans_q)     : safeJson(row.base_q);
  const title            = row.trans_title || row.base_title;
  const topic            = row.trans_topic || row.base_topic;
  const memory_verse     = row.trans_mv    || row.base_mv;
  const lesson_background= row.trans_bg    || row.base_bg;
  const lesson_conclusion= row.trans_conc  || row.base_conc;
  return {
    id:row.id, unit_id:row.unit_id, category_id:row.category_id,
    lesson_number:row.lesson_number, title, lesson_date:row.lesson_date, topic,
    quarter_theme:row.quarter_theme, suggested_hymns:row.suggested_hymns,
    devotional_reading:row.devotional_reading, memory_verse,
    memory_verse_passage:row.memory_verse_passage, lesson_background,
    lesson_conclusion, lesson_part, devotional_days, questions, sort_order:row.sort_order,
    content:{
      lesson_number:row.lesson_number, lesson_date:row.lesson_date, topic,
      quarter_theme:row.quarter_theme, suggested_hymns:row.suggested_hymns,
      devotional_reading:row.devotional_reading, memory_verse,
      memoryVerse_bible_passage:row.memory_verse_passage,
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

// ─────────────────────────────────────────────────────────────────────────────
// LESSONS — public routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/lessons/preview', async (req, res) => {
  const { category='adult', lang='en', limit=4 } = req.query;
  const max = Math.min(parseInt(limit,10)||4, 20);
  try {
    const r = await db.query(`
      SELECT l.id, l.lesson_number, l.memory_verse_passage,
             COALESCE(lt.title,l.title) AS title
      FROM lessons l
      LEFT JOIN lesson_translations lt ON lt.lesson_id=l.id AND lt.lang_code=$1
      WHERE l.category_id=$2 ORDER BY l.lesson_number ASC LIMIT $3
    `, [lang, category, max]);
    res.json(r.rows.map(r=>({ id:r.id, lessonNumber:r.lesson_number, title:r.title||'', scripture:r.memory_verse_passage||'' })));
  } catch (e) { res.status(500).json({ error:'Failed to fetch preview lessons.' }); }
});

app.get('/api/units/:unitId/lessons', async (req, res) => {
  const lang = req.query.lang || 'en';
  try {
    const r = await db.query(
      LESSON_SELECT + ` WHERE l.unit_id=$2 ORDER BY l.sort_order, l.lesson_number`,
      [lang, req.params.unitId]
    );
    res.json(r.rows.map(mergeLesson));
  } catch (e) { res.status(500).json({ error:'Failed to fetch lessons for unit.' }); }
});

app.get('/api/lessons/by-number/:number', async (req, res) => {
  const { category='adult', lang='en' } = req.query;
  try {
    const r = await db.query(
      LESSON_SELECT + ` WHERE l.lesson_number=$2 AND l.category_id=$3 LIMIT 1`,
      [lang, req.params.number, category]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Lesson not found.' });
    res.json(mergeLesson(r.rows[0]));
  } catch (e) { res.status(500).json({ error:'Failed to fetch lesson.' }); }
});

app.get('/api/lessons/:id', async (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const lang = req.query.lang || 'en';
  if (isNaN(id)) return res.status(400).json({ error:'Invalid lesson id.' });
  try {
    const r = await db.query(LESSON_SELECT + ` WHERE l.id=$2`, [lang, id]);
    if (!r.rows.length) return res.status(404).json({ error:'Lesson not found.' });
    res.json(mergeLesson(r.rows[0]));
  } catch (e) { res.status(500).json({ error:'Failed to fetch lesson.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LESSONS — admin CRUD
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/lessons/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const lr = await db.query('SELECT * FROM lessons WHERE id=$1', [id]);
    if (!lr.rows.length) return res.status(404).json({ error:'Lesson not found.' });
    const tr = await db.query('SELECT * FROM lesson_translations WHERE lesson_id=$1', [id]);
    const translations = {};
    tr.rows.forEach(t => { translations[t.lang_code] = t; });
    res.json({ ...lr.rows[0], translations });
  } catch (e) { res.status(500).json({ error:'Failed to fetch lesson.' }); }
});

async function saveLessonTranslations(lessonId, content) {
  for (const lang of ['yo','ig','ha']) {
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
      lessonId, lang, t.title||null, t.topic||null, t.memory_verse||null,
      t.background||null, t.conclusion||null,
      JSON.stringify(t.lesson_part||[]),
      JSON.stringify(t.devotional_days||[]),
      JSON.stringify(t.questions||[]),
    ]);
  }
}

app.post('/api/admin/lessons', adminAuth, async (req, res) => {
  const {
    unit_id, lesson_number, title, lesson_date, topic, quarter_theme,
    suggested_hymns, devotional_reading, memory_verse, memory_verse_passage,
    sort_order, content={},
  } = req.body;
  if (!unit_id||!title) return res.status(400).json({ error:'unit_id and title required.' });
  try {
    const uR = await db.query('SELECT category_id FROM units WHERE id=$1', [unit_id]);
    if (!uR.rows.length) return res.status(400).json({ error:'Unit not found.' });
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
      unit_id, category_id, lesson_number||null, title, lesson_date||null, topic||null,
      quarter_theme||null, suggested_hymns||null, devotional_reading||null,
      en.memory_verse||memory_verse||null, memory_verse_passage||null,
      en.background||null, en.conclusion||null,
      JSON.stringify(en.lesson_part||[]),
      JSON.stringify(en.devotional_days||[]),
      JSON.stringify(en.questions||[]),
      sort_order||0,
    ]);
    await saveLessonTranslations(r.rows[0].id, content);
    res.status(201).json({ ...r.rows[0], message:'Lesson created.' });
  } catch (e) {
    console.error('admin/lessons POST:', e.message);
    res.status(500).json({ error:'Failed to create lesson: '+e.message });
  }
});

app.put('/api/admin/lessons/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    unit_id, lesson_number, title, lesson_date, topic, quarter_theme,
    suggested_hymns, devotional_reading, memory_verse, memory_verse_passage,
    sort_order, content={},
  } = req.body;
  if (!title) return res.status(400).json({ error:'title required.' });
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
      unit_id||null, category_id, lesson_number||null, title, lesson_date||null,
      topic||null, quarter_theme||null, suggested_hymns||null, devotional_reading||null,
      en.memory_verse||memory_verse||null, memory_verse_passage||null,
      en.background||null, en.conclusion||null,
      JSON.stringify(en.lesson_part||[]),
      JSON.stringify(en.devotional_days||[]),
      JSON.stringify(en.questions||[]),
      sort_order??null, id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error:'Lesson not found.' });
    await saveLessonTranslations(id, content);
    res.json({ ...r.rows[0], message:'Lesson updated.' });
  } catch (e) {
    console.error('admin/lessons PUT:', e.message);
    res.status(500).json({ error:'Failed to update lesson.' });
  }
});

app.delete('/api/admin/lessons/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM lessons WHERE id=$1', [req.params.id]);
    res.json({ message:'Lesson deleted.' });
  } catch (e) { res.status(500).json({ error:'Failed to delete lesson.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/quiz/:lessonId', async (req, res) => {
  try {
    const { category, lang } = req.query;
    let query  = 'SELECT * FROM lesson_quizzes WHERE lesson_id=$1';
    const params = [req.params.lessonId];
    if (category && category!=='all') {
      params.push(category);
      query += ` AND (category_id='all' OR category_id=$${params.length})`;
    }
    if (lang && lang!=='en') {
      params.push(lang);
      query += ` AND (lang='en' OR lang=$${params.length})`;
    }
    query += ' ORDER BY id';
    res.json((await db.query(query, params)).rows);
  } catch (e) { res.status(500).json({ error:'Failed to fetch quiz.' }); }
});

app.post('/api/quiz/submit', async (req, res) => {
  const { email, lessonId, score } = req.body;
  if (!email||!lessonId||score===undefined) return res.status(400).json({ error:'email, lessonId, score required.' });
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
      message:'Score saved!', score:r.rows[0].score, bestScore:r.rows[0].max_score,
      totalPoints:parseInt(t.rows[0].tp||0,10),
      lessonsCompleted:parseInt(t.rows[0].lc||0,10),
    });
  } catch (e) { res.status(500).json({ error:'Failed to save score.' }); }
});

app.post('/api/admin/quiz', adminAuth, async (req, res) => {
  const { lesson_id, question, options, correct_answer, points, category_id, lang } = req.body;
  if (!lesson_id||!question||!correct_answer) return res.status(400).json({ error:'lesson_id, question, correct_answer required.' });
  try {
    const r = await db.query(
      `INSERT INTO lesson_quizzes (lesson_id,question,options,correct_answer,points,category_id,lang)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING *`,
      [lesson_id, question, JSON.stringify(options||{}), correct_answer, points||10, category_id||'all', lang||'en']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:'Failed to create question.' }); }
});

app.put('/api/admin/quiz/:id', adminAuth, async (req, res) => {
  const { lesson_id, question, options, correct_answer, points, category_id, lang } = req.body;
  try {
    const r = await db.query(
      `UPDATE lesson_quizzes SET
         lesson_id=COALESCE($1,lesson_id), question=COALESCE($2,question),
         options=COALESCE($3::jsonb,options), correct_answer=COALESCE($4,correct_answer),
         points=COALESCE($5,points), category_id=COALESCE($6,category_id), lang=COALESCE($7,lang)
       WHERE id=$8 RETURNING *`,
      [lesson_id||null, question||null, options?JSON.stringify(options):null,
       correct_answer||null, points||null, category_id||null, lang||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Question not found.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:'Failed to update question.' }); }
});

app.delete('/api/admin/quiz/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM lesson_quizzes WHERE id=$1', [req.params.id]);
    res.json({ message:'Question deleted.' });
  } catch (e) { res.status(500).json({ error:'Failed to delete question.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD & PROGRESS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit,10)||20, 100);
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
  } catch (e) { res.status(500).json({ error:'Failed to fetch leaderboard.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH INSIGHTS — admin-only analytics for church leaders
// ─────────────────────────────────────────────────────────────────────────────
// All routes are gated by `adminAuth` (x-admin-key header). They aggregate
// data already in the DB; nothing here writes. Each route accepts an optional
// `?days=` query (default 90) for the lookback window.

const insightsWindow = (req) => {
  const n = parseInt(req.query.days, 10);
  return Number.isFinite(n) && n > 0 && n <= 730 ? n : 90;
};

// 1. Attendance trends — proxied via teacher_marks (every awarded mark = a
//    student attendance record, since teachers only mark students who showed
//    up). Returns daily + weekly counts for the lookback window plus per-class
//    totals so leaders can spot which classes have flat or declining attendance.
app.get('/api/admin/insights/attendance', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  // Inject "AND church_id = $2" only when scoped to a church; otherwise
  // (super-admin) the filter is empty and the query covers every church.
  const tmScope = churchScope(req, 2);   // for teacher_marks queries
  const cScope  = churchScope(req, 2);   // for classes JOIN — same param index
  try {
    const [daily, byClass, summary] = await Promise.all([
      db.query(`
        SELECT date_trunc('day', awarded_at)::date AS day,
               COUNT(DISTINCT (class_id, lesson_number, student_email)) AS attended
          FROM teacher_marks
         WHERE awarded_at >= NOW() - ($1 || ' days')::interval${tmScope.sql}
         GROUP BY day
         ORDER BY day ASC
      `, [String(days), ...tmScope.params]),
      db.query(`
        SELECT c.id, c.name, c.category, c.invite_code,
               COUNT(DISTINCT (tm.lesson_number, tm.student_email)) AS attendance_count,
               COUNT(DISTINCT tm.lesson_number)                     AS lessons_with_attendance
          FROM classes c
          LEFT JOIN teacher_marks tm
            ON tm.class_id = c.id
           AND tm.awarded_at >= NOW() - ($1 || ' days')::interval
         WHERE 1=1${cScope.sql ? cScope.sql.replace('AND church_id', 'AND c.church_id') : ''}
         GROUP BY c.id
         ORDER BY attendance_count DESC NULLS LAST
         LIMIT 20
      `, [String(days), ...cScope.params]),
      db.query(`
        SELECT
          COUNT(DISTINCT (class_id, lesson_number, student_email)) AS total_attendances,
          COUNT(DISTINCT student_email)                            AS unique_students,
          COUNT(DISTINCT class_id)                                 AS active_classes
        FROM teacher_marks
        WHERE awarded_at >= NOW() - ($1 || ' days')::interval${tmScope.sql}
      `, [String(days), ...tmScope.params]),
    ]);
    res.json({
      windowDays: days,
      summary:    summary.rows[0],
      daily:      daily.rows,
      byClass:    byClass.rows,
    });
  } catch (e) {
    console.error('insights/attendance:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load attendance insights.' });
  }
});

// 2. Engagement stats — totals + active-subscriber count + lesson completions
//    over time + signups over time. Gives leaders a single screen of "is the
//    app actually being used?" answers.
app.get('/api/admin/insights/engagement', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  // church-scoped vs super-admin queries diverge enough that we branch.
  // For a church admin, "engagement" means activity tied to THEIR teachers'
  // classes — quiz completions by their enrolled students, marks awarded by
  // their teachers, etc. Subscribers aren't church-scoped in the schema, so
  // a church admin sees nothing for that metric (set to 0 to keep UI sane).
  try {
    if (req.church) {
      const cid = req.church.id;
      const [totals, completionsDaily, marksDaily, classes] = await Promise.all([
        db.query(`
          SELECT
            (SELECT COUNT(*) FROM users    WHERE church_id = $1 AND role = 'teacher') AS total_teachers,
            (SELECT COUNT(DISTINCT cm.student_email)
               FROM class_members cm JOIN classes c ON c.id = cm.class_id
              WHERE c.church_id = $1)                                                 AS enrolled_students,
            (SELECT COUNT(*)
               FROM user_scores us
               JOIN class_members cm ON cm.student_email = us.email
               JOIN classes c        ON c.id = cm.class_id
              WHERE c.church_id = $1)                                                 AS total_quiz_completions,
            (SELECT COUNT(DISTINCT us.email)
               FROM user_scores us
               JOIN class_members cm ON cm.student_email = us.email
               JOIN classes c        ON c.id = cm.class_id
              WHERE c.church_id = $1
                AND us.completed_at >= NOW() - ($2 || ' days')::interval)             AS active_learners,
            (SELECT COALESCE(SUM(points), 0) FROM teacher_marks WHERE church_id = $1) AS total_points_awarded
        `, [cid, String(days)]),
        db.query(`
          SELECT date_trunc('day', us.completed_at)::date AS day, COUNT(*) AS completions
            FROM user_scores us
            JOIN class_members cm ON cm.student_email = us.email
            JOIN classes c        ON c.id = cm.class_id
           WHERE c.church_id = $1
             AND us.completed_at >= NOW() - ($2 || ' days')::interval
           GROUP BY day
           ORDER BY day ASC
        `, [cid, String(days)]),
        db.query(`
          SELECT date_trunc('day', awarded_at)::date AS day, COUNT(*) AS signups
            FROM teacher_marks
           WHERE church_id = $1
             AND awarded_at >= NOW() - ($2 || ' days')::interval
           GROUP BY day
           ORDER BY day ASC
        `, [cid, String(days)]),
        db.query(`
          SELECT category, COUNT(*) AS active, COUNT(*) AS total
            FROM classes WHERE church_id = $1
           GROUP BY category
           ORDER BY active DESC
        `, [cid]),
      ]);
      return res.json({
        windowDays:        days,
        totals:            totals.rows[0],
        completionsDaily:  completionsDaily.rows,
        signupsDaily:      marksDaily.rows,    // re-purposed: marks-awarded daily for church view
        subsByCategory:    classes.rows,        // re-purposed: classes-by-category for church view
      });
    }

    // ── Super-admin (no church scope) — original global metrics ────────
    const [totals, completionsDaily, signupsDaily, subsByCategory] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM users)                                      AS total_users,
          (SELECT COUNT(*) FROM subscribers WHERE is_active = TRUE
              AND (expiry_date IS NULL OR expiry_date > NOW()))             AS active_subscribers,
          (SELECT COUNT(*) FROM user_scores)                                AS total_quiz_completions,
          (SELECT COUNT(DISTINCT email) FROM user_scores
              WHERE completed_at >= NOW() - ($1 || ' days')::interval)      AS active_learners,
          (SELECT COALESCE(SUM(max_score), 0) FROM user_scores)             AS total_points_earned
      `, [String(days)]),
      db.query(`
        SELECT date_trunc('day', completed_at)::date AS day, COUNT(*) AS completions
          FROM user_scores
         WHERE completed_at >= NOW() - ($1 || ' days')::interval
         GROUP BY day
         ORDER BY day ASC
      `, [String(days)]),
      db.query(`
        SELECT date_trunc('day', subscription_date)::date AS day, COUNT(*) AS signups
          FROM subscribers
         WHERE subscription_date >= NOW() - ($1 || ' days')::interval
         GROUP BY day
         ORDER BY day ASC
      `, [String(days)]),
      db.query(`
        SELECT subscribed_category AS category,
               COUNT(*) FILTER (WHERE is_active = TRUE
                                 AND (expiry_date IS NULL OR expiry_date > NOW())) AS active,
               COUNT(*)                                                              AS total
          FROM subscribers
         GROUP BY subscribed_category
         ORDER BY active DESC
      `),
    ]);
    res.json({
      windowDays:        days,
      totals:            totals.rows[0],
      completionsDaily:  completionsDaily.rows,
      signupsDaily:      signupsDaily.rows,
      subsByCategory:    subsByCategory.rows,
    });
  } catch (e) {
    console.error('insights/engagement:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load engagement insights.' });
  }
});

// 3. Most completed lessons — top 25 by completion count, with title + average
//    score. Helps leaders see which lessons are landing and which are being
//    skipped.
app.get('/api/admin/insights/most-completed-lessons', churchAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  // Church-scoped path: only count quiz completions by students who are in
  // a class belonging to this church. Super-admin path: all completions.
  try {
    if (req.church) {
      const r = await db.query(`
        SELECT l.id, l.lesson_number, l.title, l.category_id, l.lesson_date,
               COUNT(us.id)                                              AS completions,
               COUNT(DISTINCT us.email)                                  AS unique_learners,
               ROUND(AVG(us.score)::numeric, 1)                          AS avg_score,
               ROUND(AVG(NULLIF(us.max_score, 0))::numeric, 1)           AS avg_max_score,
               MAX(us.completed_at)                                      AS last_completed
          FROM lessons l
          JOIN user_scores us    ON us.lesson_id = l.id
          JOIN class_members cm  ON cm.student_email = us.email
          JOIN classes c         ON c.id = cm.class_id
         WHERE c.church_id = $2
         GROUP BY l.id
         ORDER BY completions DESC, unique_learners DESC
         LIMIT $1
      `, [limit, req.church.id]);
      return res.json(r.rows);
    }
    const r = await db.query(`
      SELECT l.id, l.lesson_number, l.title, l.category_id, l.lesson_date,
             COUNT(us.id)                                              AS completions,
             COUNT(DISTINCT us.email)                                  AS unique_learners,
             ROUND(AVG(us.score)::numeric, 1)                          AS avg_score,
             ROUND(AVG(NULLIF(us.max_score, 0))::numeric, 1)           AS avg_max_score,
             MAX(us.completed_at)                                      AS last_completed
        FROM lessons l
        LEFT JOIN user_scores us ON us.lesson_id = l.id
       GROUP BY l.id
      HAVING COUNT(us.id) > 0
       ORDER BY completions DESC, unique_learners DESC
       LIMIT $1
    `, [limit]);
    res.json(r.rows);
  } catch (e) {
    console.error('insights/most-completed-lessons:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load lesson completions.' });
  }
});

// 4. Teacher performance — per-teacher rollup. Counts classes owned, students
//    enrolled, marks awarded, total points distributed, and last activity.
//    Sorted by activity so dormant teachers float to the bottom.
app.get('/api/admin/insights/teacher-performance', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  // Source of truth is the `users` table (every teacher who registered with a
  // church code lives here, even before they create a class). Stats then
  // LEFT JOIN classes / marks so a teacher with zero classes still shows up
  // with all-zero stats instead of disappearing entirely.
  const params = [String(days)];
  let where = `WHERE u.role = 'teacher'`;
  if (req.church) {
    params.push(req.church.id);
    where += ` AND u.church_id = $${params.length}`;
  }
  try {
    const r = await db.query(`
      SELECT
        u.email                                                          AS teacher_email,
        COALESCE(up.display_name, u.full_name, split_part(u.email,'@',1)) AS display_name,
        COALESCE(up.avatar_emoji, '👤')                                  AS avatar_emoji,
        COALESCE(u.approval_status, 'approved')                          AS approval_status,
        u.created_at                                                     AS joined_at,
        COUNT(DISTINCT c.id)                                             AS classes_owned,
        COUNT(DISTINCT cm.student_email)                                 AS students_enrolled,
        COUNT(tm.id) FILTER
          (WHERE tm.awarded_at >= NOW() - ($1 || ' days')::interval)     AS marks_awarded_recent,
        COALESCE(SUM(tm.points) FILTER
          (WHERE tm.awarded_at >= NOW() - ($1 || ' days')::interval), 0) AS points_awarded_recent,
        COUNT(tm.id)                                                     AS marks_awarded_total,
        COALESCE(SUM(tm.points), 0)                                      AS points_awarded_total,
        MAX(tm.awarded_at)                                               AS last_active
      FROM users u
      LEFT JOIN classes        c  ON c.teacher_email = u.email
      LEFT JOIN class_members  cm ON cm.class_id = c.id
      LEFT JOIN teacher_marks  tm ON tm.class_id = c.id
      LEFT JOIN user_profiles  up ON up.email   = u.email
      ${where}
      GROUP BY u.email, u.full_name, u.approval_status, u.created_at, up.display_name, up.avatar_emoji
      ORDER BY marks_awarded_recent DESC NULLS LAST, classes_owned DESC, u.created_at DESC
    `, params);
    res.json({ windowDays: days, teachers: r.rows });
  } catch (e) {
    console.error('insights/teacher-performance:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load teacher performance.' });
  }
});

// 5. Top engaged learners — for the engagement detail panel.
//    Different from /api/leaderboard: includes recency weighting (only counts
//    activity in the window) and is admin-only.
app.get('/api/admin/insights/top-learners', churchAuth, async (req, res) => {
  const days  = insightsWindow(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  // Church-scoped: only learners enrolled in this church's classes count.
  try {
    if (req.church) {
      const r = await db.query(`
        SELECT us.email,
               COALESCE(up.display_name, split_part(us.email, '@', 1)) AS display_name,
               COALESCE(up.avatar_emoji, '👤')                          AS avatar_emoji,
               COALESCE(up.church, '')                                  AS church,
               COUNT(DISTINCT us.lesson_id)                              AS lessons_completed,
               COALESCE(SUM(us.score), 0)                                AS total_score,
               MAX(us.completed_at)                                      AS last_active
          FROM user_scores us
          JOIN class_members cm ON cm.student_email = us.email
          JOIN classes c        ON c.id = cm.class_id
          LEFT JOIN user_profiles up ON up.email = us.email
         WHERE us.completed_at >= NOW() - ($1 || ' days')::interval
           AND c.church_id = $3
         GROUP BY us.email, up.display_name, up.avatar_emoji, up.church
         ORDER BY lessons_completed DESC, total_score DESC
         LIMIT $2
      `, [String(days), limit, req.church.id]);
      return res.json({ windowDays: days, learners: r.rows });
    }
    const r = await db.query(`
      SELECT us.email,
             COALESCE(up.display_name, split_part(us.email, '@', 1)) AS display_name,
             COALESCE(up.avatar_emoji, '👤')                          AS avatar_emoji,
             COALESCE(up.church, '')                                  AS church,
             COUNT(DISTINCT us.lesson_id)                              AS lessons_completed,
             COALESCE(SUM(us.score), 0)                                AS total_score,
             MAX(us.completed_at)                                      AS last_active
        FROM user_scores us
        LEFT JOIN user_profiles up ON up.email = us.email
       WHERE us.completed_at >= NOW() - ($1 || ' days')::interval
       GROUP BY us.email, up.display_name, up.avatar_emoji, up.church
       ORDER BY lessons_completed DESC, total_score DESC
       LIMIT $2
    `, [String(days), limit]);
    res.json({ windowDays: days, learners: r.rows });
  } catch (e) {
    console.error('insights/top-learners:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load top learners.' });
  }
});

// 6. Per-category lesson stats — average score, completion rate, hardest /
//    easiest lesson per age group. Powers the lesson-detail panel.
app.get('/api/admin/insights/lesson-categories', churchAuth, async (req, res) => {
  try {
    if (req.church) {
      const r = await db.query(`
        SELECT l.category_id                                                  AS category,
               COUNT(DISTINCT l.id)                                           AS total_lessons,
               COUNT(DISTINCT us.lesson_id)                                   AS lessons_attempted,
               COUNT(us.id)                                                   AS total_completions,
               COUNT(DISTINCT us.email)                                       AS unique_learners,
               ROUND(AVG(us.score)::numeric, 1)                               AS avg_score
          FROM lessons l
          LEFT JOIN user_scores us ON us.lesson_id = l.id
          LEFT JOIN class_members cm ON cm.student_email = us.email
          LEFT JOIN classes c        ON c.id = cm.class_id AND c.church_id = $1
         WHERE us.id IS NULL OR c.id IS NOT NULL
         GROUP BY l.category_id
         ORDER BY total_completions DESC NULLS LAST
      `, [req.church.id]);
      return res.json(r.rows);
    }
    const r = await db.query(`
      SELECT l.category_id                                                  AS category,
             COUNT(DISTINCT l.id)                                           AS total_lessons,
             COUNT(DISTINCT us.lesson_id)                                   AS lessons_attempted,
             COUNT(us.id)                                                   AS total_completions,
             COUNT(DISTINCT us.email)                                       AS unique_learners,
             ROUND(AVG(us.score)::numeric, 1)                               AS avg_score
        FROM lessons l
        LEFT JOIN user_scores us ON us.lesson_id = l.id
       GROUP BY l.category_id
       ORDER BY total_completions DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('insights/lesson-categories:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load category stats.' });
  }
});

// 7. Mark-type distribution — how teachers are awarding marks
//    (answered_question vs memory_verse vs bonus). Powers the teacher panel.
app.get('/api/admin/insights/mark-distribution', churchAuth, async (req, res) => {
  const days = insightsWindow(req);
  const scope = churchScope(req, 2);
  try {
    const r = await db.query(`
      SELECT mark_type,
             COUNT(*)               AS count,
             COALESCE(SUM(points),0) AS total_points
        FROM teacher_marks
       WHERE awarded_at >= NOW() - ($1 || ' days')::interval${scope.sql}
       GROUP BY mark_type
       ORDER BY count DESC
    `, [String(days), ...scope.params]);
    res.json({ windowDays: days, breakdown: r.rows });
  } catch (e) {
    console.error('insights/mark-distribution:', e.code || '(no code)', e.message);
    res.status(500).json({ error: 'Failed to load mark distribution.' });
  }
});

app.get('/api/progress/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const scores = await db.query(`
      SELECT us.lesson_id, us.score AS last_score, COALESCE(us.max_score,us.score) AS best_score,
             us.completed_at, l.lesson_number, l.title, l.topic, l.category_id,
             (SELECT COUNT(*) FROM lesson_quizzes WHERE lesson_id=us.lesson_id)::int AS total_questions
      FROM user_scores us JOIN lessons l ON l.id=us.lesson_id
      WHERE us.email=$1 ORDER BY l.lesson_number
    `, [email]);
    const totalLessons = await db.query('SELECT COUNT(*) FROM lessons');
    const prof         = await db.query('SELECT * FROM user_profiles WHERE email=$1', [email]);
    const rows         = scores.rows;
    const totalBest    = rows.reduce((s,r)=>s+parseInt(r.best_score,10),0);
    const rankR = await db.query(`
      SELECT rank FROM (
        SELECT email, RANK() OVER (ORDER BY SUM(COALESCE(max_score,score)) DESC) AS rank
        FROM user_scores GROUP BY email
      ) t WHERE email=$1`, [email]);
    res.json({
      email, profile:prof.rows[0]||null,
      completedCount:rows.length, totalLessons:parseInt(totalLessons.rows[0].count,10),
      totalPoints:totalBest,
      rank:rankR.rows[0]?parseInt(rankR.rows[0].rank,10):null,
      lessons:rows.map(r=>({
        lessonId:r.lesson_id, lessonNumber:r.lesson_number, title:r.title, topic:r.topic,
        categoryId:r.category_id, lastScore:parseInt(r.last_score,10), bestScore:parseInt(r.best_score,10),
        totalQuestions:r.total_questions,
        percent:r.total_questions>0?Math.round((parseInt(r.best_score,10)/r.total_questions)*100):0,
        completedAt:r.completed_at,
      })),
    });
  } catch (e) { res.status(500).json({ error:'Failed to fetch progress.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/profile/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const r = await db.query('SELECT * FROM user_profiles WHERE email=$1', [email]);
    res.json(r.rows[0]||{ email });
  } catch (e) { res.status(500).json({ error:'Failed to fetch profile.' }); }
});

app.put('/api/profile/:email', async (req, res) => {
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
      email, display_name||null, avatar_emoji||null, church||null, location||null,
      lang_pref||null, dark_mode!==undefined?dark_mode:null, notifications!==undefined?notifications:null,
    ]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:'Failed to update profile.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// HYMNS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/hymns/:number', async (req, res) => {
  const n = parseInt(req.params.number, 10);
  if (isNaN(n)) return res.status(400).json({ error:'Invalid hymn number.' });
  try {
    const r = await db.query('SELECT * FROM hymns WHERE number=$1', [n]);
    if (!r.rows.length) return res.status(404).json({ error:`Hymn #${n} not found.` });
    const h = r.rows[0];
    res.json({ id:h.id, number:h.number, title:h.title, author:h.author||null, chorus:h.chorus||null, verses:h.verses||[] });
  } catch (e) { res.status(500).json({ error:'Failed to fetch hymn.' }); }
});

app.get('/api/hymns', async (req, res) => {
  const numbers = (req.query.numbers||'').split(',').map(s=>parseInt(s.trim(),10)).filter(n=>n>0);
  if (!numbers.length) return res.status(400).json({ error:'Provide ?numbers=290,480' });
  try {
    const ph = numbers.map((_,i)=>`$${i+1}`).join(',');
    const r  = await db.query(`SELECT * FROM hymns WHERE number IN (${ph}) ORDER BY number`, numbers);
    const byNum = Object.fromEntries(r.rows.map(h=>[h.number,h]));
    res.json(numbers.map(n=>byNum[n]||null).filter(Boolean));
  } catch (e) { res.status(500).json({ error:'Failed to fetch hymns.' }); }
});

app.get('/api/admin/hymns', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id,number,title,author, chorus IS NOT NULL AS has_chorus, jsonb_array_length(verses) AS verse_count FROM hymns ORDER BY number'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:'Failed to fetch hymns.' }); }
});

app.post('/api/admin/hymns', adminAuth, async (req, res) => {
  const { number, title, author, chorus, verses } = req.body;
  if (!number||!title||!Array.isArray(verses)) return res.status(400).json({ error:'number, title, verses[] required.' });
  try {
    const r = await db.query(
      `INSERT INTO hymns (number,title,author,chorus,verses) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (number) DO UPDATE SET title=EXCLUDED.title, author=EXCLUDED.author,
         chorus=EXCLUDED.chorus, verses=EXCLUDED.verses RETURNING *`,
      [number, title, author||null, chorus||null, JSON.stringify(verses)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:'Failed to save hymn.' }); }
});

app.delete('/api/admin/hymns/:number', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM hymns WHERE number=$1 RETURNING id', [parseInt(req.params.number,10)]);
    if (!r.rows.length) return res.status(404).json({ error:'Hymn not found.' });
    res.json({ message:`Hymn #${req.params.number} deleted.` });
  } catch (e) { res.status(500).json({ error:'Failed to delete hymn.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, role='student', church_code } = req.body;
  const safeRole = ['student','teacher'].includes(role) ? role : 'student';
  if (!email||!password) return res.status(400).json({ error:'Email and password required.' });
  if (password.length<6) return res.status(400).json({ error:'Password must be at least 6 characters.' });

  // Teachers MUST provide a valid church invite code so all their data flows
  // to the right church admin. Students don't need one.
  let churchId = null;
  if (safeRole === 'teacher') {
    const code = (church_code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Teachers must provide a church invite code.' });
    const c = await db.query('SELECT id FROM churches WHERE invite_code = $1', [code]);
    if (!c.rows.length) return res.status(400).json({ error: 'Unknown church code. Ask your church admin for the correct code.' });
    churchId = c.rows[0].id;
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error:'Account already exists.' });
    const hash = await bcrypt.hash(password, 12);

    // Teachers start as 'pending' — the church admin must approve them
    // before they can sign in. Students keep the default 'approved'.
    const approvalStatus = safeRole === 'teacher' ? 'pending' : 'approved';

    const r    = await db.query(
      `INSERT INTO users (email,password_hash,full_name,role,church_id,approval_status)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,email,full_name,role,church_id,approval_status`,
      [email.toLowerCase(), hash, full_name||null, safeRole, churchId, approvalStatus]
    );
    await db.query(
      `INSERT INTO user_profiles (email,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [email.toLowerCase(), full_name||null]
    );
    const user  = r.rows[0];

    // Pending teachers get a 201 with a pending flag — no token, since they
    // can't actually use the app until approved.
    if (user.approval_status === 'pending') {
      return res.status(201).json({
        message: 'Application submitted. Your church admin will review and approve your account before you can sign in.',
        user: { id:user.id, email:user.email, full_name:user.full_name, role:user.role, church_id:user.church_id },
        approval_status: 'pending',
        pending: true,
      });
    }

    const token = Buffer.from(`${user.email}:${Date.now()}:${Math.random()}`).toString('base64');
    res.status(201).json({
      message:'Account created!',
      user:{ id:user.id, email:user.email, full_name:user.full_name, role:user.role, church_id:user.church_id },
      token,
    });
  } catch (e) { console.error('register:', e.message); res.status(500).json({ error:'Registration failed.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password, force=false } = req.body;
  if (!email||!password) return res.status(400).json({ error:'Email and password required.' });
  try {
    const r = await db.query(
      `SELECT id,email,password_hash,full_name,role,session_token,session_at,
              COALESCE(approval_status,'approved') AS approval_status,
              rejected_reason
         FROM users WHERE email=$1`,
      [email.toLowerCase()]
    );
    if (!r.rows.length) return res.status(401).json({ error:'No account found with this email.' });
    const user  = r.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error:'Incorrect password.' });

    // Teacher approval gate — block pending/rejected before issuing a token.
    if (user.role === 'teacher' && user.approval_status !== 'approved') {
      const status  = user.approval_status;
      const message = status === 'pending'
        ? 'Your teacher account is awaiting approval from your church admin. You will be able to sign in once approved.'
        : (user.rejected_reason
            ? `Your teacher account application was declined: ${user.rejected_reason}`
            : 'Your teacher account application was declined. Contact your church admin.');
      return res.status(403).json({ error: status, message });
    }
    // Single-session enforcement
    if (user.session_token && user.session_at) {
      const ageDays = (Date.now()-new Date(user.session_at).getTime()) / 86400000;
      if (ageDays < 30 && !force) {
        return res.status(409).json({
          error:'already_logged_in',
          message:'This account is already logged in on another device. Do you want to log that device out?',
        });
      }
    }
    const token = Buffer.from(`${user.email}:${Date.now()}:${Math.random()}`).toString('base64');
    await db.query('UPDATE users SET session_token=$1, session_at=NOW() WHERE email=$2', [token, user.email]);
    const prof = await db.query('SELECT * FROM user_profiles WHERE email=$1', [user.email]);
    console.log('[Auth] Login: %s (force=%s)', user.email, force);
    res.json({
      message:'Login successful!',
      user:{ id:user.id, email:user.email, full_name:user.full_name, role:user.role||'student' },
      profile:prof.rows[0]||null, token,
    });
  } catch (e) { console.error('login:', e.message); res.status(500).json({ error:'Login failed.' }); }
});

app.post('/api/auth/validate-session', async (req, res) => {
  const { email, token } = req.body;
  if (!email||!token) return res.status(400).json({ valid:false, reason:'missing' });
  try {
    const r = await db.query('SELECT session_token FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (!r.rows.length) return res.json({ valid:false, reason:'user_not_found' });
    const stored = r.rows[0].session_token;
    if (!stored) return res.json({ valid:false, reason:'no_token' });
    const valid = stored===token;
    res.json({ valid, reason:valid?null:'session_replaced' });
  } catch (e) { res.status(500).json({ valid:false, reason:'error' }); }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { email, current_password, new_password } = req.body;
  if (!email||!current_password||!new_password) return res.status(400).json({ error:'All fields required.' });
  if (new_password.length<6) return res.status(400).json({ error:'New password must be at least 6 characters.' });
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error:'User not found.' });
    if (!await bcrypt.compare(current_password, r.rows[0].password_hash))
      return res.status(401).json({ error:'Current password incorrect.' });
    const hash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE email=$2', [hash, email.toLowerCase()]);
    res.json({ message:'Password changed.' });
  } catch (e) { res.status(500).json({ error:'Could not change password.' }); }
});

app.delete('/api/auth/account', async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'email and password required.' });
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error:'User not found.' });
    if (!await bcrypt.compare(password, r.rows[0].password_hash))
      return res.status(401).json({ error:'Incorrect password.' });
    await db.query('DELETE FROM users WHERE email=$1', [email.toLowerCase()]);
    await db.query('DELETE FROM user_profiles WHERE email=$1', [email.toLowerCase()]);
    await db.query('DELETE FROM user_scores WHERE email=$1', [email.toLowerCase()]);
    res.json({ message:'Account deleted.' });
  } catch (e) { res.status(500).json({ error:'Could not delete account.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT & SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────
const VALID_CATS = ['children','intermediate','youth','adult','all'];
const VALID_PLANS = ['single','all'];

// Resolve a plan from the DB; falls back to legacy hardcoded values if the
// table is missing/empty (so a partly-migrated env still works).
async function getPlanPricing(planId) {
  try {
    const r = await db.query(
      'SELECT plan_id, price_kobo, days FROM subscription_plans WHERE plan_id=$1',
      [planId]
    );
    if (r.rows[0]) return r.rows[0];
  } catch (e) { /* table may not exist on first run — fall through */ }
  return planId === 'all'
    ? { plan_id:'all',    price_kobo:100000, days:SUBSCRIPTION_DAYS }
    : { plan_id:'single', price_kobo:50000,  days:SUBSCRIPTION_DAYS };
}

// Public — frontend reads this on mount to populate price/days for both plans
app.get('/api/subscription/plans', async (_req, res) => {
  try {
    const r = await db.query(
      'SELECT plan_id, price_kobo, days, updated_at FROM subscription_plans ORDER BY price_kobo'
    );
    if (!r.rows.length) {
      // Empty table — return defaults
      return res.json([
        { plan_id:'single', price_kobo:50000,  days:SUBSCRIPTION_DAYS },
        { plan_id:'all',    price_kobo:100000, days:SUBSCRIPTION_DAYS },
      ]);
    }
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/subscription/plans:',
      e.code || '(no code)',
      e.message || '(no message)',
      e.stack ? '\n' + e.stack.split('\n').slice(0, 4).join('\n') : '');
    res.status(500).json({ error:'Failed to load plans.' });
  }
});

// Admin — update price/days for a single plan
app.put('/api/admin/subscription/plans/:planId', adminAuth, async (req, res) => {
  const planId = req.params.planId;
  if (!VALID_PLANS.includes(planId)) {
    return res.status(400).json({ error:`plan_id must be one of: ${VALID_PLANS.join(', ')}` });
  }
  const price_kobo = parseInt(req.body.price_kobo, 10);
  const days       = parseInt(req.body.days,       10);
  if (!Number.isFinite(price_kobo) || price_kobo < 100) {
    return res.status(400).json({ error:'price_kobo must be an integer ≥ 100 (i.e. ₦1).' });
  }
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return res.status(400).json({ error:'days must be an integer between 1 and 3650.' });
  }
  try {
    const r = await db.query(`
      INSERT INTO subscription_plans (plan_id, price_kobo, days, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (plan_id) DO UPDATE SET
        price_kobo = EXCLUDED.price_kobo,
        days       = EXCLUDED.days,
        updated_at = NOW()
      RETURNING *
    `, [planId, price_kobo, days]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/subscription/plans:', e.message);
    res.status(500).json({ error:'Failed to update plan.' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  const { reference, email, category='adult' } = req.body;
  if (!reference||!email) return res.status(400).json({ status:'error', message:'reference and email required.' });
  if (!isValidEmail(email)) return res.status(400).json({ status:'error', message:'Invalid email.' });
  const userEmail    = email.toLowerCase();
  const safeCategory = VALID_CATS.includes(category) ? category : 'adult';
  try {
    const pRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers:{ Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const txn = pRes.data?.data;
    if (!txn||txn.status!=='success') return res.status(400).json({ status:'error', message:'Payment not successful.' });
    if (txn.customer?.email?.toLowerCase()!==userEmail) return res.status(400).json({ status:'error', message:'Email mismatch.' });
    const dup = await db.query('SELECT * FROM subscribers WHERE paystack_ref=$1', [reference]);
    if (dup.rows.length) return res.json({ status:'success', data:dup.rows[0] });
    const planType = safeCategory==='all' ? 'all' : 'single';
    const plan     = await getPlanPricing(planType);
    const now      = new Date(), exp = addDays(now, plan.days);
    // Trust Paystack's actual charged amount; fall back to admin-configured DB price
    const priceKobo = txn.amount || plan.price_kobo;
    const r = await db.query(`
      INSERT INTO subscribers
        (email,is_active,subscription_date,expiry_date,paystack_ref,subscribed_category,price_kobo,plan_type)
      VALUES ($1,TRUE,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (email) DO UPDATE SET is_active=TRUE,
        subscription_date=EXCLUDED.subscription_date, expiry_date=EXCLUDED.expiry_date,
        paystack_ref=EXCLUDED.paystack_ref, subscribed_category=EXCLUDED.subscribed_category,
        price_kobo=EXCLUDED.price_kobo, plan_type=EXCLUDED.plan_type, updated_at=NOW()
      RETURNING *
    `, [userEmail, now, exp, reference, safeCategory, priceKobo, planType]);
    console.log('[Sub] Activated %s → plan:%s cat:%s', userEmail, planType, safeCategory);
    res.json({
      status:'success', success:true, expiry_date:r.rows[0].expiry_date,
      subscribed_category:safeCategory, plan_type:planType, price_kobo:priceKobo, data:r.rows[0],
    });
  } catch (e) {
    console.error('verify-payment:', e?.response?.data?.message||e.message);
    res.status(500).json({ status:'error', message:'Failed to verify payment.' });
  }
});

// Used by the app's SubscriptionContext
app.post('/api/subscription/verify', async (req, res) => {
  const { reference, email, category='adult' } = req.body;
  if (!reference||!email) return res.status(400).json({ success:false, message:'Missing reference or email' });
  try {
    const pRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers:{ Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY||''}` } }
    );
    if (!pRes.data.status||pRes.data.data?.status!=='success')
      return res.json({ success:false, message:'Payment not confirmed by Paystack.' });
    const safeCategory = VALID_CATS.includes(category) ? category : 'adult';
    const planType     = safeCategory==='all' ? 'all' : 'single';
    const plan         = await getPlanPricing(planType);
    const exp          = new Date(); exp.setDate(exp.getDate()+plan.days);
    const expiry       = exp.toISOString();
    const priceKobo    = plan.price_kobo;
    await db.query(`
      INSERT INTO subscribers
        (email,is_active,expiry_date,paystack_ref,subscription_date,subscribed_category,plan_type,price_kobo)
      VALUES ($1,TRUE,$2,$3,NOW(),$4,$5,$6)
      ON CONFLICT (email) DO UPDATE SET is_active=TRUE, expiry_date=$2, paystack_ref=$3,
        subscription_date=NOW(), subscribed_category=$4, plan_type=$5, price_kobo=$6, updated_at=NOW()
    `, [email, expiry, reference, safeCategory, planType, priceKobo]);
    console.log('✅ subscription/verify: %s → %s/%s', email, planType, safeCategory);
    return res.json({ success:true, expiry_date:expiry, subscribed_category:safeCategory, plan_type:planType });
  } catch (e) {
    console.error('subscription/verify error:', e.message);
    if (e.response) return res.json({ success:false, message:`Paystack: ${e.response.data?.message||'Verification failed'}` });
    return res.status(500).json({ success:false, message:'Server error during verification.' });
  }
});

app.get('/api/subscription/status/:email', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT is_active, expiry_date, subscribed_category, plan_type, price_kobo,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [req.params.email]);
    if (!r.rows.length) return res.json({ active:false, expiry_date:null });
    const sub = r.rows[0];
    let days_remaining = null;
    if (sub.expiry_date) {
      days_remaining = Math.max(0, Math.ceil((new Date(sub.expiry_date)-new Date())/86400000));
    }
    return res.json({
      active:sub.active===true, expiry_date:sub.expiry_date, days_remaining,
      subscribed_category:sub.subscribed_category||'adult',
      plan_type:sub.plan_type||'single', price_kobo:sub.price_kobo||50000,
    });
  } catch (e) { return res.status(500).json({ error:e.message }); }
});

app.get('/api/subscription/can-access/:email/:categoryId', async (req, res) => {
  const { email, categoryId } = req.params;
  if (!email||!categoryId) return res.status(400).json({ canAccess:false, reason:'missing_params' });
  try {
    const r = await db.query(`
      SELECT is_active, expiry_date, subscribed_category, plan_type,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [email]);
    if (!r.rows.length) return res.json({ canAccess:false, reason:'no_subscription' });
    const sub = r.rows[0];
    if (!sub.active) return res.json({ canAccess:false, reason:'expired' });
    if (sub.plan_type==='all'||sub.subscribed_category==='all')
      return res.json({ canAccess:true, reason:'all_access', subscribed_category:sub.subscribed_category });
    const allowed = sub.subscribed_category===categoryId;
    return res.json({
      canAccess:allowed, reason:allowed?'category_match':'wrong_category',
      subscribed_category:sub.subscribed_category,
    });
  } catch (e) { res.status(500).json({ canAccess:false, reason:'server_error' }); }
});

app.get('/api/check-status/:email', async (req, res) => {
  const email = req.params.email?.toLowerCase().trim();
  if (!email||!isValidEmail(email)) return res.status(400).json({ canAccess:false, reason:'Invalid email.' });
  try {
    const r = await db.query('SELECT * FROM subscribers WHERE email=$1', [email]);
    if (!r.rows.length) return res.json({ canAccess:false, reason:'No subscription found.' });
    const user=r.rows[0], now=new Date(), exp=new Date(user.expiry_date);
    if (!user.is_active||now>exp) {
      db.query('UPDATE subscribers SET is_active=FALSE WHERE email=$1', [email]).catch(()=>{});
      return res.json({ canAccess:false, reason:'Subscription expired.', expiredAt:user.expiry_date });
    }
    res.json({ canAccess:true, email:user.email, expiryDate:user.expiry_date, daysLeft:Math.ceil((exp-now)/86400000) });
  } catch (e) { res.status(500).json({ canAccess:false, reason:'Server error.' }); }
});

app.get('/api/subscribers', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id,email,is_active,subscription_date,expiry_date,
             subscribed_category,plan_type,price_kobo,paystack_ref,created_at,updated_at
      FROM subscribers ORDER BY created_at DESC
    `);
    res.json({ count:r.rows.length, subscribers:r.rows });
  } catch (e) { res.status(500).json({ message:e.message }); }
});

app.delete('/api/revoke/:email', adminAuth, async (req, res) => {
  const email = req.params.email?.toLowerCase().trim();
  try {
    await db.query('UPDATE subscribers SET is_active=FALSE WHERE email=$1', [email]);
    res.json({ message:`Revoked for ${email}.` });
  } catch (e) { res.status(500).json({ message:e.message }); }
});

app.post('/api/admin/grant-access', adminAuth, async (req, res) => {
  const { email, days, reference, expiry_date, subscribed_category, plan_type } = req.body;
  if (!email) return res.status(400).json({ error:'Email is required' });
  try {
    const safeCategory = VALID_CATS.includes(subscribed_category) ? subscribed_category : 'adult';
    const safePlan     = VALID_PLANS.includes(plan_type) ? plan_type : 'single';
    const plan         = await getPlanPricing(safePlan);
    const expiry = expiry_date || (() => {
      const d = new Date(); d.setDate(d.getDate() + (days || plan.days)); return d.toISOString();
    })();
    const priceKobo = plan.price_kobo;
    await db.query(`
      INSERT INTO subscribers
        (email,is_active,subscription_date,expiry_date,paystack_ref,subscribed_category,plan_type,price_kobo)
      VALUES ($1,TRUE,NOW(),$2,$3,$4,$5,$6)
      ON CONFLICT (email) DO UPDATE SET is_active=TRUE, expiry_date=$2, paystack_ref=$3,
        subscribed_category=$4, plan_type=$5, price_kobo=$6, subscription_date=NOW(), updated_at=NOW()
    `, [email, expiry, reference||'ADMIN_GRANT', safeCategory, safePlan, priceKobo]);
    console.log('[Admin] Access granted to %s | cat:%s | plan:%s | until %s', email, safeCategory, safePlan, expiry);
    res.json({ success:true, email, expiry_date:expiry, subscribed_category:safeCategory, plan_type:safePlan });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/webhook/paystack', express.raw({ type:'application/json' }), async (req, res) => {
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  if (hash!==req.headers['x-paystack-signature']) return res.status(400).json({ message:'Invalid signature.' });
  const event = JSON.parse(req.body);
  if (event.event==='charge.success') {
    const { reference, customer, status } = event.data;
    if (status!=='success') return res.sendStatus(200);
    const email=customer.email.toLowerCase(), now=new Date(), exp=addDays(now, SUBSCRIPTION_DAYS);
    try {
      await db.query(
        `INSERT INTO subscribers (email,is_active,subscription_date,expiry_date,paystack_ref)
         VALUES ($1,TRUE,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET is_active=TRUE,
           subscription_date=EXCLUDED.subscription_date,
           expiry_date=EXCLUDED.expiry_date, paystack_ref=EXCLUDED.paystack_ref`,
        [email, now, exp, reference]
      );
    } catch (e) { console.error('webhook DB error:', e.message); }
  }
  res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// QUARTER INFO
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/quarter-info', async (req, res) => {
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
        quarter:'Q4 2026', year:2026,
        theme_title:'Demonstration of the Christian Life',
        theme_sub:'Exposition on the Book of Philemon',
        book:'Philemon', book_full:'Book of Philemon',
        lesson_count:13, period:'October – December 2026', memory_verse:'Philemon 1:1–25',
      });
    }
    const row = r.rows[0];
    res.json({
      id:row.id, quarter:row.quarter, year:row.year,
      theme_title:  row.tr_theme_title  || row.theme_title,
      theme_sub:    row.tr_theme_sub    || row.theme_sub,
      book:row.book, book_full:row.book_full, lesson_count:row.lesson_count,
      period:       row.tr_period       || row.period,
      memory_verse: row.tr_memory_verse || row.memory_verse,
      lang,
    });
  } catch (e) { console.error('quarter-info:', e.message); res.status(500).json({ error:e.message }); }
});

app.get('/api/admin/quarter-info', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM quarter_info ORDER BY id DESC');
    const quarters = await Promise.all(r.rows.map(async q => {
      const tr = await db.query('SELECT * FROM quarter_translations WHERE quarter_id=$1', [q.id]);
      const translations = {};
      tr.rows.forEach(row => {
        translations[row.lang_code] = {
          theme_title:row.theme_title, theme_sub:row.theme_sub,
          period:row.period, memory_verse:row.memory_verse,
        };
      });
      return { ...q, translations };
    }));
    res.json(quarters);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

async function saveQuarterTranslations(quarterId, translations) {
  if (!translations||typeof translations!=='object') return;
  for (const [lang, tr] of Object.entries(translations)) {
    await db.query(`
      INSERT INTO quarter_translations (quarter_id,lang_code,theme_title,theme_sub,period,memory_verse)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (quarter_id,lang_code) DO UPDATE SET
        theme_title=$3, theme_sub=$4, period=$5, memory_verse=$6
    `, [quarterId, lang, tr.theme_title||null, tr.theme_sub||null, tr.period||null, tr.memory_verse||null]);
  }
}

app.post('/api/admin/quarter-info', adminAuth, async (req, res) => {
  const { quarter, year, theme_title, theme_sub, book, book_full, lesson_count, period, memory_verse, is_current, translations } = req.body;
  if (!quarter||!theme_title) return res.status(400).json({ error:'quarter and theme_title required.' });
  try {
    if (is_current) await db.query('UPDATE quarter_info SET is_current=FALSE');
    const r = await db.query(`
      INSERT INTO quarter_info
        (quarter,year,theme_title,theme_sub,book,book_full,lesson_count,period,memory_verse,is_current)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [quarter,year||2026,theme_title,theme_sub||null,book||null,book_full||null,lesson_count||13,period||null,memory_verse||null,is_current||false]);
    await saveQuarterTranslations(r.rows[0].id, translations);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/admin/quarter-info/:id', adminAuth, async (req, res) => {
  const { quarter, year, theme_title, theme_sub, book, book_full, lesson_count, period, memory_verse, is_current, translations } = req.body;
  try {
    if (is_current) await db.query('UPDATE quarter_info SET is_current=FALSE WHERE id!=$1', [req.params.id]);
    const r = await db.query(`
      UPDATE quarter_info SET quarter=$1,year=$2,theme_title=$3,theme_sub=$4,book=$5,book_full=$6,
        lesson_count=$7,period=$8,memory_verse=$9,is_current=$10 WHERE id=$11 RETURNING *
    `, [quarter,year||2026,theme_title,theme_sub||null,book||null,book_full||null,lesson_count||13,period||null,memory_verse||null,is_current||false,req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error:'Quarter not found.' });
    await saveQuarterTranslations(req.params.id, translations);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/quarter-info/:id/set-current', adminAuth, async (req, res) => {
  try {
    await db.query('UPDATE quarter_info SET is_current=FALSE');
    await db.query('UPDATE quarter_info SET is_current=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/admin/quarter-info/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM quarter_info WHERE id=$1', [req.params.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AD BANNERS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/banners/active', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id,title,image_base64,image_url,link_url,expires_at FROM ad_banners
      WHERE is_active=TRUE
        AND (scheduled_at IS NULL OR scheduled_at<=NOW())
        AND (expires_at IS NULL OR expires_at>NOW())
      ORDER BY created_at DESC LIMIT 1
    `);
    res.json({ banner:r.rows[0]||null });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id,title,image_url,image_base64,is_active,scheduled_at,expires_at,created_at FROM ad_banners ORDER BY created_at DESC'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/banners', adminAuth, async (req, res) => {
  const { title, image_base64, image_url, link_url, is_active, scheduled_at, expires_at } = req.body;
  try {
    const r = await db.query(
      `INSERT INTO ad_banners (title,image_base64,image_url,link_url,is_active,scheduled_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title||null,image_base64||null,image_url||null,link_url||null,is_active||false,scheduled_at||null,expires_at||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/admin/banners/:id', adminAuth, async (req, res) => {
  const { title, image_base64, image_url, link_url, is_active, scheduled_at, expires_at } = req.body;
  try {
    if (is_active) await db.query('UPDATE ad_banners SET is_active=FALSE WHERE id!=$1', [req.params.id]);
    const r = await db.query(
      `UPDATE ad_banners SET title=$1,image_base64=$2,image_url=$3,link_url=$4,is_active=$5,
       scheduled_at=$6,expires_at=$7,updated_at=NOW() WHERE id=$8 RETURNING *`,
      [title||null,image_base64||null,image_url||null,link_url||null,is_active||false,scheduled_at||null,expires_at||null,req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try { await db.query('DELETE FROM ad_banners WHERE id=$1', [req.params.id]); res.json({ success:true }); }
  catch (e) { res.status(500).json({ error:e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// BIBLE VERSES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/bible-verse/:reference', async (req, res) => {
  try {
    const ref = decodeURIComponent(req.params.reference);
    const r   = await db.query('SELECT text,version FROM bible_verses WHERE LOWER(reference)=LOWER($1)', [ref]);
    if (r.rows.length) return res.json({ reference:ref, text:r.rows[0].text, version:r.rows[0].version, source:'db' });
    res.json({ reference:ref, text:null, source:'not_found' });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/admin/bible-verses', adminAuth, async (req, res) => {
  try { res.json((await db.query('SELECT * FROM bible_verses ORDER BY created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/admin/bible-verses', adminAuth, async (req, res) => {
  const { reference, text, version } = req.body;
  if (!reference||!text) return res.status(400).json({ error:'Reference and text required' });
  try {
    const r = await db.query(
      `INSERT INTO bible_verses (reference,text,version) VALUES ($1,$2,$3)
       ON CONFLICT (reference) DO UPDATE SET text=$2, version=$3, created_at=NOW() RETURNING *`,
      [reference.trim(), text.trim(), version||'KJV']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/admin/bible-verses/:id', adminAuth, async (req, res) => {
  try { await db.query('DELETE FROM bible_verses WHERE id=$1', [req.params.id]); res.json({ success:true }); }
  catch (e) { res.status(500).json({ error:e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/teacher/classes', async (req, res) => {
  const { teacher_email, name, description, category } = req.body;
  if (!teacher_email||!name) return res.status(400).json({ error:'teacher_email and name required.' });
  try {
    const invite_code = Math.random().toString(36).substring(2,8).toUpperCase();
    const r = await db.query(
      'INSERT INTO classes (teacher_email,name,description,category,invite_code) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [teacher_email, name, description||'', category||'adult', invite_code]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/teacher/classes', async (req, res) => {
  const { teacher_email } = req.query;
  if (!teacher_email) return res.status(400).json({ error:'teacher_email required.' });
  try {
    const r = await db.query(
      `SELECT c.*, COUNT(DISTINCT cm.student_email) AS student_count
       FROM classes c LEFT JOIN class_members cm ON cm.class_id=c.id
       WHERE c.teacher_email=$1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [teacher_email]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/teacher/classes/:classId/members', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT cm.student_email, cm.joined_at, COALESCE(up.display_name,cm.student_email) AS display_name, up.avatar_emoji
       FROM class_members cm LEFT JOIN user_profiles up ON up.email=cm.student_email
       WHERE cm.class_id=$1 ORDER BY display_name`,
      [req.params.classId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/teacher/classes/join', async (req, res) => {
  const { invite_code, student_email } = req.body;
  if (!invite_code||!student_email) return res.status(400).json({ error:'invite_code and student_email required.' });
  try {
    const cls = await db.query('SELECT * FROM classes WHERE invite_code=$1', [invite_code.toUpperCase()]);
    if (!cls.rows.length) return res.status(404).json({ error:'Invalid invite code.' });
    await db.query(
      'INSERT INTO class_members (class_id,student_email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [cls.rows[0].id, student_email]
    );
    res.json({ message:'Joined class.', class:cls.rows[0] });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// Teacher-initiated add (by email). Verifies the requesting teacher actually
// owns the class before inserting — prevents one teacher altering another's roster.
app.post('/api/teacher/classes/:classId/add-student', async (req, res) => {
  const classId = parseInt(req.params.classId, 10);
  const { teacher_email, student_email } = req.body || {};
  if (!teacher_email || !student_email) {
    return res.status(400).json({ error:'teacher_email and student_email are required.' });
  }
  const email = String(student_email).trim().toLowerCase();
  if (!isValidEmail(email)) return res.status(400).json({ error:'Invalid student email.' });
  try {
    const cls = await db.query('SELECT * FROM classes WHERE id=$1', [classId]);
    if (!cls.rows.length) return res.status(404).json({ error:'Class not found.' });
    if (cls.rows[0].teacher_email?.toLowerCase() !== teacher_email.toLowerCase()) {
      return res.status(403).json({ error:'Only the class owner can add students.' });
    }
    const dup = await db.query(
      'SELECT 1 FROM class_members WHERE class_id=$1 AND student_email=$2',
      [classId, email]
    );
    if (dup.rows.length) return res.status(409).json({ error:'Student is already in this class.' });
    await db.query(
      'INSERT INTO class_members (class_id,student_email) VALUES ($1,$2)',
      [classId, email]
    );
    const profile = await db.query(
      'SELECT display_name, avatar_emoji FROM user_profiles WHERE email=$1', [email]
    );
    res.status(201).json({
      message:'Student added.',
      student: {
        student_email: email,
        display_name:  profile.rows[0]?.display_name || email,
        avatar_emoji:  profile.rows[0]?.avatar_emoji || null,
      },
    });
  } catch (e) {
    console.error('teacher/add-student:', e.message);
    res.status(500).json({ error:'Failed to add student.' });
  }
});

// Teacher removes a student from a class (also ownership-checked)
app.delete('/api/teacher/classes/:classId/members/:email', async (req, res) => {
  const classId = parseInt(req.params.classId, 10);
  const email   = decodeURIComponent(req.params.email).toLowerCase();
  const teacher_email = (req.query.teacher_email || '').toLowerCase();
  if (!teacher_email) return res.status(400).json({ error:'teacher_email query required.' });
  try {
    const cls = await db.query('SELECT teacher_email FROM classes WHERE id=$1', [classId]);
    if (!cls.rows.length) return res.status(404).json({ error:'Class not found.' });
    if (cls.rows[0].teacher_email?.toLowerCase() !== teacher_email) {
      return res.status(403).json({ error:'Only the class owner can remove students.' });
    }
    await db.query('DELETE FROM class_members WHERE class_id=$1 AND student_email=$2', [classId, email]);
    res.json({ message:'Student removed.' });
  } catch (e) {
    console.error('teacher/remove-student:', e.message);
    res.status(500).json({ error:'Failed to remove student.' });
  }
});

app.get('/api/teacher/attendance', async (req, res) => {
  const { class_id, lesson_number } = req.query;
  if (!class_id) return res.status(400).json({ error:'class_id required.' });
  try {
    const r = await db.query(
      `SELECT cm.student_email, COALESCE(up.display_name,cm.student_email) AS display_name,
              up.avatar_emoji, COALESCE(a.present,false) AS present, a.marked_at
       FROM class_members cm
       LEFT JOIN user_profiles up ON up.email=cm.student_email
       LEFT JOIN attendance a ON a.class_id=cm.class_id AND a.student_email=cm.student_email AND a.lesson_number=$2
       WHERE cm.class_id=$1 ORDER BY display_name`,
      [class_id, lesson_number||1]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/teacher/attendance/bulk', async (req, res) => {
  const { class_id, lesson_number, records, marked_by } = req.body;
  if (!class_id||!lesson_number||!Array.isArray(records)) return res.status(400).json({ error:'Missing fields.' });
  try {
    for (const rec of records) {
      await db.query(
        `INSERT INTO attendance (class_id,lesson_number,student_email,present,marked_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (class_id,lesson_number,student_email) DO UPDATE SET present=$4,marked_by=$5,marked_at=NOW()`,
        [class_id, lesson_number, rec.student_email, !!rec.present, marked_by||'']
      );
    }
    res.json({ message:`${records.length} records saved.` });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/teacher/marks', async (req, res) => {
  const { class_id, lesson_number } = req.query;
  if (!class_id) return res.status(400).json({ error:'class_id required.' });
  try {
    const extra  = lesson_number ? ' AND tm.lesson_number=$2' : '';
    const params = lesson_number ? [class_id, lesson_number] : [class_id];
    const r = await db.query(
      `SELECT tm.*, COALESCE(up.display_name,tm.student_email) AS display_name, up.avatar_emoji
       FROM teacher_marks tm LEFT JOIN user_profiles up ON up.email=tm.student_email
       WHERE tm.class_id=$1${extra} ORDER BY tm.awarded_at DESC`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/teacher/marks', async (req, res) => {
  const { class_id, lesson_number, student_email, mark_type, points, note, awarded_by } = req.body;
  if (!class_id||!lesson_number||!student_email||!mark_type) return res.status(400).json({ error:'Missing fields.' });
  try {
    const r = await db.query(
      'INSERT INTO teacher_marks (class_id,lesson_number,student_email,mark_type,points,note,awarded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [class_id, lesson_number, student_email, mark_type, points||0, note||'', awarded_by||'']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/teacher/marks/:markId', async (req, res) => {
  try { await db.query('DELETE FROM teacher_marks WHERE id=$1', [req.params.markId]); res.json({ message:'Mark removed.' }); }
  catch (e) { res.status(500).json({ error:e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE SYNC — drains the teacher's local AsyncStorage queue.
// Body: {
//   teacher_email,
//   classes:    [{ local_id, name, description, category, ... }],   // local-only roster classes
//   roster:     [{ local_class_id?, server_class_id?, name, email? }],
//   attendance: [{ local_class_id?, server_class_id?, lesson_number, student_local_id, student_email?, present, marked_at }],
//   marks:      [{ local_class_id?, server_class_id?, lesson_number, student_local_id, student_email?, mark_type, points, note, awarded_at }],
// }
//
// Returns:
//   { ok: true, mappings: { classes: { localId: serverId }, students: { localId: email } } }
//
// The mappings let the client update its local records' synced=true flag and
// remember the server IDs so subsequent syncs use them directly.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/teacher/sync', async (req, res) => {
  const { teacher_email, classes = [], roster = [], attendance = [], marks = [] } = req.body || {};
  if (!teacher_email) return res.status(400).json({ error: 'teacher_email required.' });

  // Look up the teacher's church_id once — every record gets stamped with it.
  // Two-step lookup so we can tell "no such email" apart from "exists but not a teacher".
  const u = await db.query('SELECT role, church_id FROM users WHERE email = $1', [teacher_email.toLowerCase()]);
  if (!u.rows.length) {
    return res.status(404).json({ code: 'no_account', error: 'No account found for this email on the server. Register a teacher account first.' });
  }
  if (u.rows[0].role !== 'teacher') {
    return res.status(403).json({ code: 'not_a_teacher', error: 'This account is not a teacher account. Re-register as a teacher with your church invite code to sync.' });
  }
  const churchId = u.rows[0].church_id;
  if (!churchId) {
    return res.status(400).json({ code: 'no_church', error: 'Teacher is not assigned to a church. Re-register with your church invite code.' });
  }

  const classMap   = {};   // local_id → server_id
  const studentMap = {};   // local_id → student_email (local students get a synthetic email)

  try {
    // ── 1. Classes — create any new ones the teacher made offline ────────
    for (const c of classes) {
      if (!c?.local_id || !c?.name) continue;
      // Each church-scoped class gets a unique invite_code
      let inviteCode, attempts = 0;
      while (attempts++ < 8) {
        inviteCode = randCode(6);
        const dup = await db.query('SELECT 1 FROM classes WHERE invite_code = $1', [inviteCode]);
        if (!dup.rows.length) break;
      }
      const r = await db.query(`
        INSERT INTO classes (teacher_email, name, description, category, invite_code, church_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [teacher_email.toLowerCase(), c.name, c.description || null, c.category || 'adult', inviteCode, churchId]);
      classMap[c.local_id] = r.rows[0].id;
    }

    // Helper: resolve a record's class_id, preferring the server_class_id if
    // present (for previously-synced classes), else the freshly-mapped one.
    const resolveClassId = (rec) =>
      rec.server_class_id || classMap[rec.local_class_id] || null;

    // ── 2. Roster — for name-only students (no email), synthesize a stable
    //    pseudo-email so class_members has something to key on. Pattern:
    //    `local_<teacherDomainSafe>_<localId>@local.gofamint`. This is
    //    intentionally unguessable by other systems — it's a local marker.
    const synthEmail = (teacherEmail, localId) =>
      `local_${teacherEmail.replace(/[^a-z0-9]/g, '')}_${localId}@local.gofamint`;

    for (const m of roster) {
      const classId = resolveClassId(m);
      if (!classId || !m.local_id) continue;
      const email = (m.email && m.email.toLowerCase()) || synthEmail(teacher_email, m.local_id);
      studentMap[m.local_id] = email;
      // Keep their display_name in user_profiles so leaderboards can show it
      if (m.name) {
        await db.query(`
          INSERT INTO user_profiles (email, display_name)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
        `, [email, m.name]);
      }
      await db.query(
        'INSERT INTO class_members (class_id, student_email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [classId, email]
      );
    }

    // ── 3. Attendance ────────────────────────────────────────────────────
    let attendanceWritten = 0;
    for (const a of attendance) {
      const classId = resolveClassId(a);
      const email   = (a.student_email && a.student_email.toLowerCase())
                   || studentMap[a.student_local_id];
      if (!classId || !email || !a.lesson_number) continue;
      await db.query(`
        INSERT INTO attendance (class_id, lesson_number, student_email, present, marked_by, marked_at, church_id)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7)
        ON CONFLICT (class_id, lesson_number, student_email) DO UPDATE SET
          present = EXCLUDED.present, marked_at = EXCLUDED.marked_at, marked_by = EXCLUDED.marked_by
      `, [classId, a.lesson_number, email, !!a.present, teacher_email.toLowerCase(), a.marked_at || null, churchId]);
      attendanceWritten++;
    }

    // ── 4. Teacher marks ─────────────────────────────────────────────────
    let marksWritten = 0;
    for (const m of marks) {
      const classId = resolveClassId(m);
      const email   = (m.student_email && m.student_email.toLowerCase())
                   || studentMap[m.student_local_id];
      if (!classId || !email || !m.lesson_number || !m.mark_type) continue;
      await db.query(`
        INSERT INTO teacher_marks (class_id, lesson_number, student_email, mark_type, points, note, awarded_by, awarded_at, church_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), $9)
      `, [classId, m.lesson_number, email, m.mark_type, parseInt(m.points, 10) || 0, m.note || null, teacher_email.toLowerCase(), m.awarded_at || null, churchId]);
      marksWritten++;
    }

    res.json({
      ok: true,
      church_id: churchId,
      mappings:   { classes: classMap, students: studentMap },
      counts:     { classes: Object.keys(classMap).length, roster: roster.length, attendance: attendanceWritten, marks: marksWritten },
    });
  } catch (e) {
    console.error('teacher/sync:', e.code, e.message);
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

app.get('/api/teacher/progress', async (req, res) => {
  const { class_id } = req.query;
  if (!class_id) return res.status(400).json({ error:'class_id required.' });
  try {
    const r = await db.query(`
      SELECT cm.student_email,
        COALESCE(up.display_name,cm.student_email) AS display_name, up.avatar_emoji,
        COUNT(DISTINCT a.lesson_number) FILTER (WHERE a.present=TRUE) AS lessons_attended,
        COUNT(DISTINCT a.lesson_number) AS lessons_marked,
        COALESCE((SELECT SUM(us2.max_score) FROM user_scores us2 WHERE us2.email=cm.student_email),0) AS quiz_total,
        COALESCE((SELECT SUM(tm2.points) FROM teacher_marks tm2 WHERE tm2.class_id=$1 AND tm2.student_email=cm.student_email),0) AS teacher_points
      FROM class_members cm
      LEFT JOIN user_profiles up ON up.email=cm.student_email
      LEFT JOIN attendance a ON a.class_id=cm.class_id AND a.student_email=cm.student_email
      WHERE cm.class_id=$1
      GROUP BY cm.student_email, up.display_name, up.avatar_emoji
      ORDER BY (quiz_total+teacher_points) DESC
    `, [class_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));