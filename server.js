const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const cors    = require('cors');
const axios   = require('axios');
const db      = require('./db');
const { sendApprovalEmail, sendRejectionEmail, sendMail } = require('./services/mailer');
const { publishToPlatform } = require('./services/socialPublishers');
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
      plan_type           VARCHAR(64)  DEFAULT 'single',
      price_kobo          INTEGER      DEFAULT 50000,
      created_at          TIMESTAMPTZ  DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  DEFAULT NOW()
    )`,

    // Safe migrations for existing databases without these columns
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS subscribed_category VARCHAR(20) DEFAULT 'adult'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan_type           VARCHAR(64) DEFAULT 'single'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS price_kobo          INTEGER     DEFAULT 50000`,
    // Widen plan_type on existing prod DBs that originally had VARCHAR(20).
    // Per-book SKUs like 'book_victory_month_prayer' are 26 chars and
    // would 22001-truncate without this. Idempotent — no-op if already 64.
    `ALTER TABLE subscribers ALTER COLUMN plan_type TYPE VARCHAR(64)`,
    // Per-book subscription roster — comma-separated book IDs. Coexists with
    // subscribed_category: that one keeps powering Sunday School age-group
    // gating; this one powers book-level gating (Victory Month Prayer etc.).
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS subscribed_books    TEXT        DEFAULT ''`,

    // ── 2026-05 fix: prevent the DEFAULT 'adult' on subscribed_category from
    //    leaking Sunday-School access to users who only bought a book.
    //
    // The column default still exists (so legacy /api/subscription/verify
    // category-only flow keeps working), but for any row whose plan_type is
    // a book SKU (`book_*`), we clear subscribed_category to NULL so they
    // can no longer pass the SS gate. Idempotent — safe to re-run.
    `UPDATE subscribers
        SET subscribed_category = NULL
      WHERE plan_type LIKE 'book_%'
        AND subscribed_category IS NOT NULL`,

    // ── Subscription plan pricing (admin-editable) ───────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_plans (
      plan_id     VARCHAR(20)  PRIMARY KEY,
      price_kobo  INTEGER      NOT NULL,
      days        INTEGER      NOT NULL DEFAULT 300,
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    )`,
    // Widen plan_id BEFORE inserting any book SKU — existing prod DBs have
    // VARCHAR(20) and book IDs like 'book_victory_month_prayer' (27 chars)
    // would 22001 truncate without this. New DBs get the widened type from
    // the CREATE TABLE call up the file (still safe to ALTER as no-op).
    `ALTER TABLE subscription_plans ALTER COLUMN plan_id TYPE VARCHAR(64)`,
    // USD pricing for international payments via Stripe. Naira is the source
    // of truth (price_kobo); USD is admin-configured separately because FX
    // drift makes auto-conversion unreliable. 0 = no Stripe price set yet —
    // the Stripe init endpoint refuses to start a session for such plans.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_usd_cents INTEGER NOT NULL DEFAULT 0`,
    `INSERT INTO subscription_plans (plan_id, price_kobo, days) VALUES
       ('single', 50000,  300),
       ('all',    100000, 300),
       -- Per-book SKUs. Adding a new book = one INSERT line here + an entry
       -- in frontend/data/books.js. Admin Pricing page can edit the price
       -- after deploy via the same /api/admin/subscription/plans/:id route.
       ('book_victory_month_prayer', 50000, 365)
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

    // ── Daily reading tracker (streaks + XP + badges) ────────────────────────
    // One row per (email, date). Source captures whether the check-in came
    // from a lesson view, devotional view, or a manual button tap. Duration
    // is tracked when the check-in was auto-fired by the in-app timer.
    `CREATE TABLE IF NOT EXISTS daily_reading_log (
       id               SERIAL       PRIMARY KEY,
       email            VARCHAR(255) NOT NULL,
       reading_date     DATE         NOT NULL,
       source_type      VARCHAR(20)  NOT NULL DEFAULT 'lesson',
       lesson_id        INT          REFERENCES lessons(id) ON DELETE SET NULL,
       duration_seconds INT          DEFAULT 0,
       created_at       TIMESTAMPTZ  DEFAULT NOW(),
       UNIQUE (email, reading_date)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_drl_email_date ON daily_reading_log (email, reading_date DESC)`,

    // Gamification denormalised onto user_profiles so the Stats screen can
    // load with a single PK lookup. Streak math + XP awards still happen
    // server-side on every check-in.
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS current_streak INT  DEFAULT 0`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS longest_streak INT  DEFAULT 0`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_read_date  DATE`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS lifetime_xp     INT  DEFAULT 0`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS badges          JSONB DEFAULT '[]'::jsonb`,

    // ── Library: books catalog + per-book daily entries ──────────────────────
    // Two-shape model: Sunday School (route_screen='HomeScreen') uses its own
    // categories/units/lessons hierarchy; every other book ('BookReader') uses
    // the generic book_entries table below — one row per day or vigil session.
    `CREATE TABLE IF NOT EXISTS books (
       id              SERIAL        PRIMARY KEY,
       slug            VARCHAR(60)   UNIQUE NOT NULL,
       title           VARCHAR(120)  NOT NULL,
       subtitle        VARCHAR(200),
       description     TEXT,
       cover_image_url TEXT,
       cover_emoji     VARCHAR(10)   DEFAULT '📖',
       accent_color    VARCHAR(20)   DEFAULT '#1A56DB',
       route_screen    VARCHAR(40)   DEFAULT 'BookReader',
       available       BOOLEAN       DEFAULT TRUE,
       sort_order      INT           DEFAULT 100,
       language        VARCHAR(10)   DEFAULT 'en',
       created_at      TIMESTAMPTZ   DEFAULT NOW(),
       updated_at      TIMESTAMPTZ   DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_books_sort ON books (sort_order, id)`,

    // book_entries — one row per day (entry_type='daily') OR per vigil session
    // (entry_type IN 'family_vigil','youth_vigil','women_vigil','men_vigil',
    // 'general_vigil'). UNIQUE constraint lets the admin upsert by (book, day,
    // type), so re-seeding from the JSON file is idempotent.
    `CREATE TABLE IF NOT EXISTS book_entries (
       id                    SERIAL       PRIMARY KEY,
       book_id               INT          REFERENCES books(id) ON DELETE CASCADE,
       entry_number          INT          NOT NULL,
       entry_type            VARCHAR(20)  NOT NULL DEFAULT 'daily',
       entry_date            DATE,
       focus                 TEXT,
       scripture_text        VARCHAR(500),
       inspirational_message TEXT,
       prayer_points         JSONB        DEFAULT '[]'::jsonb,
       special_intercession  TEXT,
       hymn                  JSONB,
       discussion_questions  JSONB,
       declarations          JSONB,
       sort_order            INT          DEFAULT 100,
       created_at            TIMESTAMPTZ  DEFAULT NOW(),
       UNIQUE (book_id, entry_number, entry_type)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_book_entries_book ON book_entries (book_id, entry_number)`,

    // ── Library + Victory Month: per-row translations (PDF #11) ────────────
    // JSONB shape: { yo: { title, subtitle, … }, ig: {...}, ha: {...} }.
    // Empty/missing language keys fall back to the English columns at read
    // time. Adding a new language is a no-op — no migration needed.
    `ALTER TABLE books         ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE book_entries  ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}'::jsonb`,

    // Seed Sunday School inline so the Library is never empty on a fresh DB.
    // route_screen='HomeScreen' tells the mobile app to send taps into the
    // existing Sunday School flow (categories → units → lessons) rather than
    // the generic BookReader screen.
    `INSERT INTO books (slug, title, subtitle, description, cover_emoji, accent_color, route_screen, sort_order, available)
     VALUES (
       'sunday-school',
       'Sunday School Manual',
       'GOFAMINT weekly lessons',
       'Quarterly Sunday School lessons for all four age groups — Children, Intermediate, Youth, and Adult — in English, Yorùbá, Igbo, and Hausa.',
       '📚',
       '#1A56DB',
       'HomeScreen',
       1,
       TRUE
     )
     ON CONFLICT (slug) DO NOTHING`,

    // Seed the Victory Month Prayer book row so the admin dashboard and the
    // mobile app can both reach it via slug. Entries (the 30 days + 6 vigils)
    // are NOT seeded here — they're loaded from the bundled JS data the first
    // time the admin presses "Seed initial content" in the dashboard, which
    // POSTs into /api/admin/books/:slug/seed.
    // Slug must match the JSON seed (backend/scripts/victory-month-2026.json)
    // and the dashboard/mobile constants (VICTORY_BOOK_SLUG). The full
    // metadata + 37 entries land via `node scripts/seed-victory-month.js`;
    // this inline insert only ensures the row exists on a fresh DB.
    `INSERT INTO books (slug, title, subtitle, description, cover_emoji, accent_color, route_screen, sort_order, available)
     VALUES (
       'victory-month-2026',
       'Victory Month Prayer Bulletin 2026',
       '30-day prayer & fasting · Jan 2 – 31, 2026',
       'GOFAMINT Victory Month Prayer Bulletin. Daily prayer focus, scripture meditation, intercession, plus group vigils for family / youth / women / men / general.',
       '🙏',
       '#DC2626',
       'VictoryMonthHome',
       2,
       TRUE
     )
     ON CONFLICT (slug) DO NOTHING`,

    // ── Multi-branch support (PDF item #1) ─────────────────────────────────
    // A branch is a campus or location belonging to one church. Most existing
    // entities (users, classes, attendance, teacher_marks) gain an optional
    // branch_id so the admin dashboard can filter to a single branch.
    `CREATE TABLE IF NOT EXISTS branches (
       id              SERIAL       PRIMARY KEY,
       church_id       INT          NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       name            VARCHAR(200) NOT NULL,
       location        VARCHAR(200),
       is_headquarters BOOLEAN      NOT NULL DEFAULT FALSE,
       created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
       UNIQUE (church_id, name)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_branches_church ON branches(church_id)`,

    `ALTER TABLE users         ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id) ON DELETE SET NULL`,
    `ALTER TABLE classes       ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id) ON DELETE SET NULL`,
    `ALTER TABLE attendance    ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id) ON DELETE SET NULL`,
    `ALTER TABLE teacher_marks ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_users_branch         ON users(branch_id)         WHERE branch_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_classes_branch       ON classes(branch_id)       WHERE branch_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_branch    ON attendance(branch_id)    WHERE branch_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_teacher_marks_branch ON teacher_marks(branch_id) WHERE branch_id IS NOT NULL`,

    // ── Staff roster (PDF item #1: role-based access control) ──────────────
    // Each church has a roster of staff members with a role. Today the only
    // person who logs in is the church's admin_email (token-based), so the
    // backfill inserts that email as a pastor automatically; per-user logins
    // are a future pass.
    `CREATE TABLE IF NOT EXISTS staff (
       id          SERIAL       PRIMARY KEY,
       church_id   INT          NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id   INT          REFERENCES branches(id) ON DELETE SET NULL,
       email       VARCHAR(255) NOT NULL,
       name        VARCHAR(200),
       role        VARCHAR(40)  NOT NULL DEFAULT 'worker',
       status      VARCHAR(20)  NOT NULL DEFAULT 'active',
       created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
       UNIQUE (church_id, email)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_staff_church ON staff(church_id)`,
    `CREATE INDEX IF NOT EXISTS idx_staff_email  ON staff(LOWER(email))`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'staff_role_check'
       ) THEN
         ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (
           role IN ('super_admin','pastor','finance','worker','sunday_school_teacher','member')
         );
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'staff_status_check'
       ) THEN
         ALTER TABLE staff ADD CONSTRAINT staff_status_check CHECK (
           status IN ('active','invited','disabled')
         );
       END IF;
     END $$`,

    // ── Activity log (PDF item #1: real-time activity tracking) ────────────
    // One row per audit-worthy action. Frontend polls the cursor endpoint to
    // surface a live feed.
    `CREATE TABLE IF NOT EXISTS activity_log (
       id           BIGSERIAL    PRIMARY KEY,
       church_id    INT          NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id    INT          REFERENCES branches(id) ON DELETE SET NULL,
       actor_email  VARCHAR(255),
       actor_name   VARCHAR(200),
       action       VARCHAR(80)  NOT NULL,
       entity_type  VARCHAR(40),
       entity_id    VARCHAR(80),
       summary      TEXT         NOT NULL,
       metadata     JSONB,
       created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_church_created ON activity_log(church_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_branch_created ON activity_log(branch_id, created_at DESC) WHERE branch_id IS NOT NULL`,

    // ── Auto-seed an HQ branch + pastor staff row for each existing church ─
    // Idempotent: only inserts where missing.
    `INSERT INTO branches (church_id, name, location, is_headquarters)
       SELECT c.id, 'Headquarters', c.location, TRUE
         FROM churches c
        WHERE NOT EXISTS (
          SELECT 1 FROM branches b WHERE b.church_id = c.id
        )`,
    `INSERT INTO staff (church_id, email, name, role, status)
       SELECT c.id, LOWER(c.admin_email), COALESCE(c.contact_name, c.admin_email), 'pastor', 'active'
         FROM churches c
        WHERE c.admin_email IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM staff s
             WHERE s.church_id = c.id AND LOWER(s.email) = LOWER(c.admin_email)
          )`,
    // Backfill branch_id on existing rows to point at each church's HQ branch.
    `UPDATE users u
        SET branch_id = b.id
       FROM branches b
      WHERE u.branch_id IS NULL
        AND u.church_id IS NOT NULL
        AND b.church_id = u.church_id
        AND b.is_headquarters = TRUE`,
    `UPDATE classes c
        SET branch_id = b.id
       FROM branches b
      WHERE c.branch_id IS NULL
        AND c.church_id IS NOT NULL
        AND b.church_id = c.church_id
        AND b.is_headquarters = TRUE`,
    `UPDATE attendance a
        SET branch_id = b.id
       FROM branches b
      WHERE a.branch_id IS NULL
        AND a.church_id IS NOT NULL
        AND b.church_id = a.church_id
        AND b.is_headquarters = TRUE`,
    `UPDATE teacher_marks tm
        SET branch_id = b.id
       FROM branches b
      WHERE tm.branch_id IS NULL
        AND tm.church_id IS NOT NULL
        AND b.church_id = tm.church_id
        AND b.is_headquarters = TRUE`,

    // ── Member management (PDF item #2) ───────────────────────────────────
    // Distinct from `users` (app accounts: teachers + students) and `staff`
    // (administrative roles). A member is a row in the congregation registry.
    // Some members will also have a `users` account — joined by email — but
    // most won't.
    `CREATE TABLE IF NOT EXISTS families (
       id              SERIAL       PRIMARY KEY,
       church_id       INT          NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id       INT          REFERENCES branches(id) ON DELETE SET NULL,
       name            VARCHAR(200) NOT NULL,
       head_member_id  INT,                     -- FK added below, after members exists
       address         TEXT,
       notes           TEXT,
       created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
       updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_families_church ON families(church_id)`,
    `CREATE INDEX IF NOT EXISTS idx_families_branch ON families(branch_id) WHERE branch_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS members (
       id              SERIAL        PRIMARY KEY,
       church_id       INT           NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id       INT           REFERENCES branches(id) ON DELETE SET NULL,
       family_id       INT           REFERENCES families(id) ON DELETE SET NULL,
       family_role     VARCHAR(20),  -- head|spouse|child|dependent|other
       first_name      VARCHAR(120)  NOT NULL,
       last_name       VARCHAR(120),
       email           VARCHAR(255),
       phone           VARCHAR(50),
       gender          VARCHAR(10),  -- male|female|other
       date_of_birth   DATE,
       marital_status  VARCHAR(20),
       address         TEXT,
       occupation      VARCHAR(150),
       status          VARCHAR(20)   NOT NULL DEFAULT 'member',
       photo_base64    TEXT,
       joined_at       DATE          NOT NULL DEFAULT CURRENT_DATE,
       notes           TEXT,
       created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
       updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_members_church  ON members(church_id)`,
    `CREATE INDEX IF NOT EXISTS idx_members_branch  ON members(branch_id) WHERE branch_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_members_family  ON members(family_id) WHERE family_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_members_status  ON members(status)`,
    `CREATE INDEX IF NOT EXISTS idx_members_email   ON members(LOWER(email)) WHERE email IS NOT NULL`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_status_check') THEN
         ALTER TABLE members ADD CONSTRAINT members_status_check CHECK (
           status IN ('visitor','first_timer','member','inactive')
         );
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_family_role_check') THEN
         ALTER TABLE members ADD CONSTRAINT members_family_role_check CHECK (
           family_role IS NULL OR family_role IN ('head','spouse','child','dependent','other')
         );
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'families_head_fk') THEN
         ALTER TABLE families
           ADD CONSTRAINT families_head_fk
           FOREIGN KEY (head_member_id) REFERENCES members(id) ON DELETE SET NULL;
       END IF;
     END $$`,

    // ── Worker / volunteer assignments ─────────────────────────────────────
    // A member can hold multiple active assignments (e.g. choir leader + youth
    // volunteer). ended_at IS NULL means the role is currently active.
    `CREATE TABLE IF NOT EXISTS worker_assignments (
       id          SERIAL       PRIMARY KEY,
       member_id   INT          NOT NULL REFERENCES members(id) ON DELETE CASCADE,
       church_id   INT          NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id   INT          REFERENCES branches(id) ON DELETE SET NULL,
       department  VARCHAR(80)  NOT NULL,
       role        VARCHAR(80)  NOT NULL DEFAULT 'member',
       started_at  DATE         NOT NULL DEFAULT CURRENT_DATE,
       ended_at    DATE,
       notes       TEXT,
       created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_worker_member     ON worker_assignments(member_id)`,
    `CREATE INDEX IF NOT EXISTS idx_worker_church     ON worker_assignments(church_id)`,
    `CREATE INDEX IF NOT EXISTS idx_worker_dept       ON worker_assignments(department) WHERE ended_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_worker_active     ON worker_assignments(church_id) WHERE ended_at IS NULL`,

    // ── Social media: connected accounts ────────────────────────────────────
    // One row per (church, platform) connection. Tokens are stored as plain
    // text — wrap with KMS / pgcrypto in production. `meta` JSONB holds
    // platform-specific fields (page_id for FB, ig_user_id for IG, etc).
    `CREATE TABLE IF NOT EXISTS social_accounts (
      id              SERIAL PRIMARY KEY,
      church_id       INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
      platform        VARCHAR(32) NOT NULL,
      account_label   TEXT,
      external_id     TEXT,
      access_token    TEXT,
      refresh_token   TEXT,
      expires_at      TIMESTAMPTZ,
      meta            JSONB DEFAULT '{}'::jsonb,
      connected_by    TEXT,
      status          VARCHAR(20) DEFAULT 'active',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (church_id, platform)
    )`,

    // ── Social media: posts ─────────────────────────────────────────────────
    // The flyer + caption the church wants to broadcast. `platforms` is the
    // requested set; `results` is the per-platform outcome (status, external
    // post id, error) populated by the dispatcher.
    `CREATE TABLE IF NOT EXISTS social_posts (
      id            SERIAL PRIMARY KEY,
      church_id     INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
      branch_id     INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      image_base64  TEXT,
      image_mime    VARCHAR(50) DEFAULT 'image/jpeg',
      caption       TEXT,
      platforms     JSONB DEFAULT '[]'::jsonb,
      results       JSONB DEFAULT '{}'::jsonb,
      status        VARCHAR(20) DEFAULT 'queued',
      scheduled_at  TIMESTAMPTZ,
      published_at  TIMESTAMPTZ,
      created_by    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_posts_church   ON social_posts(church_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_social_accounts_church ON social_accounts(church_id)`,

    // Trigger to keep members.updated_at fresh on any UPDATE.
    `DROP TRIGGER IF EXISTS members_updated_at ON members`,
    `CREATE TRIGGER members_updated_at
       BEFORE UPDATE ON members
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,
    `DROP TRIGGER IF EXISTS families_updated_at ON families`,
    `CREATE TRIGGER families_updated_at
       BEFORE UPDATE ON families
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

    // ── Certificates (PDF item #7: learning achievements) ────────────────
    // Issued manually by a church admin to a student. Keyed on the student's
    // email (matches the existing user_scores / class_members system); a
    // snapshotted display name keeps the printable certificate stable even
    // if the underlying user row later changes. `context` is JSONB for the
    // structured payload (unit_id, score, lessons_count, …) used by the
    // printout.
    `CREATE TABLE IF NOT EXISTS certificates (
       id              SERIAL        PRIMARY KEY,
       church_id       INT           NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id       INT           REFERENCES branches(id) ON DELETE SET NULL,
       student_email   VARCHAR(255)  NOT NULL,
       student_name    VARCHAR(200)  NOT NULL,
       type            VARCHAR(40)   NOT NULL,
       title           VARCHAR(200)  NOT NULL,
       body            TEXT,
       context         JSONB,
       certificate_no  VARCHAR(40)   UNIQUE NOT NULL,
       awarded_by      VARCHAR(255),
       awarded_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
       revoked_at      TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS idx_cert_church ON certificates(church_id, awarded_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_cert_email  ON certificates(LOWER(student_email))`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'certificates_type_check') THEN
         ALTER TABLE certificates ADD CONSTRAINT certificates_type_check CHECK (
           type IN ('completion','excellence','attendance','memorization','custom')
         );
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
//
// Also attaches:
//   req.staff           — the staff row for the church's admin_email (role + branch)
//   req.activeBranchId  — null = all branches; otherwise the selected branch id
//                         (read from x-branch-id header or ?branch_id query param)
const churchAuth = async (req, res, next) => {
  const masterKey = req.headers['x-admin-key'];
  if (masterKey && masterKey === process.env.ADMIN_SECRET) {
    req.church          = null;   // super-admin — no church filter
    req.staff           = { role: 'super_admin', email: null, name: 'Super Admin' };
    req.activeBranchId  = null;
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

    // Load the staff row matching the church's admin_email. The token-based
    // login doesn't carry an end-user identity, so we treat the admin_email
    // owner as the current actor. Per-user login is a future pass.
    const sr = await db.query(
      `SELECT id, branch_id, email, name, role, status
         FROM staff
        WHERE church_id = $1 AND LOWER(email) = LOWER($2)
        LIMIT 1`,
      [req.church.id, req.church.admin_email],
    );
    req.staff = sr.rows[0] || {
      role: 'pastor', email: req.church.admin_email, name: null, branch_id: null,
    };

    // Active branch comes from header (preferred) or query string. Empty /
    // "all" means no branch filter (cross-branch view).
    const rawBranch = req.headers['x-branch-id'] || req.query.branch_id || '';
    if (rawBranch && String(rawBranch).toLowerCase() !== 'all') {
      const bid = parseInt(rawBranch, 10);
      if (!Number.isFinite(bid)) {
        return res.status(400).json({ error: 'Invalid branch_id.' });
      }
      // Verify the branch belongs to this church before trusting it.
      const br = await db.query(
        'SELECT id FROM branches WHERE id = $1 AND church_id = $2',
        [bid, req.church.id],
      );
      if (!br.rows.length) {
        return res.status(403).json({ error: 'Branch not in your church.' });
      }
      req.activeBranchId = bid;
    } else {
      req.activeBranchId = null;
    }

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

// branchScope adds an AND branch_id = $Y clause when an active branch is
// selected. Use when the table has a branch_id column. Returns the same shape
// as churchScope so usage is symmetric:
//   const cs = churchScope(req, $cIdx);
//   const bs = branchScope(req, $cIdx + cs.params.length);
//   db.query(`... WHERE 1=1${cs.sql}${bs.sql}`, [...cs.params, ...bs.params]);
const branchScope = (req, paramIndex) => {
  if (!req.activeBranchId) return { sql: '', params: [] };
  return { sql: ` AND branch_id = $${paramIndex}`, params: [req.activeBranchId] };
};

// Role → allowed actions matrix. Used by the new admin endpoints to 403 calls
// that the current staff member shouldn't make. UI hides menus separately —
// this is the server-side enforcement.
const ROLE_PERMS = {
  super_admin: { branches: 'edit', staff: 'edit', activity: 'view', settings: 'edit', social: 'edit' },
  pastor:      { branches: 'edit', staff: 'edit', activity: 'view', settings: 'edit', social: 'edit' },
  finance:     { branches: 'view', staff: 'view', activity: 'view', settings: 'view', social: 'view' },
  worker:      { branches: 'view', staff: 'none', activity: 'view', settings: 'none', social: 'none' },
  sunday_school_teacher: { branches: 'view', staff: 'none', activity: 'view', settings: 'none', social: 'none' },
  member:      { branches: 'none', staff: 'none', activity: 'none', settings: 'none', social: 'none' },
};

const requirePerm = (resource, level) => (req, res, next) => {
  const role = req.staff?.role || 'member';
  const have = (ROLE_PERMS[role] || {})[resource] || 'none';
  const rank = { none: 0, view: 1, edit: 2 };
  if (rank[have] < rank[level]) {
    return res.status(403).json({ error: 'Forbidden', required: `${resource}:${level}`, have: `${resource}:${have}` });
  }
  next();
};

// Append a row to the activity log. Errors are swallowed — auditing must not
// break the operation that triggered it.
async function logActivity({ church_id, branch_id, actor_email, actor_name, action, entity_type, entity_id, summary, metadata }) {
  if (!church_id || !action || !summary) return;
  try {
    await db.query(
      `INSERT INTO activity_log
         (church_id, branch_id, actor_email, actor_name, action, entity_type, entity_id, summary, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        church_id,
        branch_id || null,
        actor_email || null,
        actor_name || null,
        action,
        entity_type || null,
        entity_id ? String(entity_id) : null,
        summary,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (e) {
    console.error('logActivity:', e.code || '(no code)', e.message);
  }
}

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

// Super-admin updates a church. Body may contain any of: name, location,
// admin_email. Unspecified fields are left untouched. admin_token and
// invite_code are intentionally NOT editable here — rotating those is a
// separate operation that should invalidate active sessions.
app.put('/api/admin/churches/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid church id.' });
  const { name, location, admin_email } = req.body || {};
  if (admin_email && !isValidEmail(admin_email)) {
    return res.status(400).json({ error: 'Invalid admin_email.' });
  }
  // Build the SET clause from whichever fields were provided. This keeps the
  // endpoint flexible — admins can rename a church without re-supplying the
  // email, and vice versa.
  const sets = [];
  const params = [];
  if (typeof name === 'string') {
    const v = name.trim();
    if (!v) return res.status(400).json({ error: 'name cannot be empty.' });
    params.push(v); sets.push(`name = $${params.length}`);
  }
  if (typeof location === 'string') {
    params.push(location.trim() || null); sets.push(`location = $${params.length}`);
  }
  if (typeof admin_email === 'string') {
    params.push(admin_email.trim().toLowerCase()); sets.push(`admin_email = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No editable fields supplied.' });
  params.push(id);
  try {
    const r = await db.query(
      `UPDATE churches SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, location, admin_email, invite_code, created_at,
                 COALESCE(approval_status, 'approved') AS approval_status`,
      params,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Church not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/churches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update church.' });
  }
});

// Super-admin deletes a church. Cascade rules on dependent tables (classes,
// students, attendance, marks, etc.) clean up automatically — but
// users.church_id is ON DELETE SET NULL, so teachers survive as "orphans"
// that can later be reassigned via /api/admin/teachers.
//
// This is destructive — pass ?confirm=1 (or set body.confirm=true) to actually
// delete. Without it the endpoint returns a preview of what would be removed
// so the UI can show a meaningful confirmation dialog.
app.delete('/api/admin/churches/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid church id.' });
  const confirmed = req.query.confirm === '1' || req.body?.confirm === true;
  try {
    const church = await db.query(
      `SELECT id, name, location, admin_email FROM churches WHERE id = $1`, [id],
    );
    if (church.rowCount === 0) return res.status(404).json({ error: 'Church not found.' });

    // Count dependents up front so the UI can warn before the actual delete.
    // Each query is small and only runs once per delete request — fine inline.
    const [{ rows: t }, { rows: cl }, { rows: st }] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n FROM users   WHERE church_id = $1 AND role = 'teacher'`, [id]),
      db.query(`SELECT COUNT(*)::int AS n FROM classes WHERE church_id = $1`, [id]),
      db.query(`SELECT COUNT(*)::int AS n FROM students WHERE church_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    const preview = {
      church:   church.rows[0],
      teachers: t[0].n,   // will be orphaned (church_id set to NULL)
      classes:  cl[0].n,  // will be cascade-deleted
      students: st[0].n,  // will be cascade-deleted
    };
    if (!confirmed) {
      return res.json({ ok: false, preview, message: 'Pass ?confirm=1 to actually delete.' });
    }

    await db.query('DELETE FROM churches WHERE id = $1', [id]);
    res.json({ ok: true, deleted: preview });
  } catch (e) {
    console.error('DELETE /api/admin/churches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete church.' });
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

    // Await the email so the admin UI can show whether it actually went out.
    // The approval itself has already committed above — any email failure is
    // a soft warning, not a rollback. (If the email fails we still return 200
    // and include the failure details under `mail`.)
    let mail;
    try {
      mail = await sendApprovalEmail(church, process.env.CHURCH_ADMIN_URL || null);
      if (!mail?.ok) {
        console.warn('[approve] email not sent to', church.admin_email, '·', mail?.error);
      }
    } catch (e) {
      console.warn('[approve] email threw:', e.message);
      mail = { ok: false, error: e.message, error_code: 'threw' };
    }

    res.json({
      message: mail?.ok
        ? 'Approved and confirmation email sent.'
        : 'Approved, but confirmation email could not be sent.',
      church,
      mail: {
        ok:         !!mail?.ok,
        id:         mail?.id || null,
        from:       mail?.from || null,
        error:      mail?.error || null,
        error_code: mail?.error_code || null,
        status:     mail?.status || null,
      },
    });
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

    let mail;
    try {
      mail = await sendRejectionEmail(church, reason);
      if (!mail?.ok) {
        console.warn('[reject] email not sent to', church.admin_email, '·', mail?.error);
      }
    } catch (e) {
      console.warn('[reject] email threw:', e.message);
      mail = { ok: false, error: e.message, error_code: 'threw' };
    }

    res.json({
      message: mail?.ok
        ? 'Rejected and notification email sent.'
        : 'Rejected, but notification email could not be sent.',
      church,
      mail: {
        ok:         !!mail?.ok,
        id:         mail?.id || null,
        from:       mail?.from || null,
        error:      mail?.error || null,
        error_code: mail?.error_code || null,
        status:     mail?.status || null,
      },
    });
  } catch (e) {
    console.error('POST /api/admin/church-applications/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Reject failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIL HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
// Two endpoints so the dashboard / Postman can verify the Resend pipeline
// without writing CLI scripts:
//
//   GET  /api/admin/mail-test   → safe config probe. Reports whether the API
//                                 key is present, what MAIL_FROM looks like,
//                                 whether the sandbox sender is in use, and
//                                 (when possible) the list of verified
//                                 domains on the Resend account. No email
//                                 is sent — costs zero send quota.
//   POST /api/admin/mail-test   → actually sends one test email to the
//                                 address in body.to. Returns the Resend
//                                 message id on success or the error code.
//
// Both endpoints are admin-only (x-admin-key). They never throw — every
// failure path returns 200 with { ok: false, error } so the dashboard can
// render a friendly diagnostic instead of a raw 500.
// ─────────────────────────────────────────────────────────────────────────────

// Inspect Resend account state. Best-effort: API errors are reported in
// the response body rather than thrown.
const probeResendDomains = async (apiKey) => {
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  try {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await r.json().catch(() => ({}));
    // 401 'restricted_api_key' is normal for a send-only key — the key works
    // for sending, it just can't list domains. We surface that as "ok but
    // can't introspect" so the UI knows not to scare the user.
    if (r.status === 401 && /restricted/i.test(data?.name || data?.message || '')) {
      return { ok: true, restricted: true, domains: [], note: 'API key is send-only — cannot list domains.' };
    }
    if (!r.ok) return { ok: false, error: data?.message || `HTTP ${r.status}` };
    const domains = (data?.data || data || []).map((d) => ({
      name:   d.name,
      status: d.status,                          // 'verified' | 'pending' | 'failed' | ...
      region: d.region,
    }));
    return { ok: true, domains };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// GET /api/admin/mail-test — health probe, doesn't send anything.
app.get('/api/admin/mail-test', adminAuth, async (req, res) => {
  const apiKey  = process.env.RESEND_API_KEY || '';
  const from    = process.env.MAIL_FROM || 'Gospelar Sunday School <noreply@gospelar.com>';
  const fromAddr = (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
  const sandbox = /resend\.dev>?$|<onboarding@resend\.dev>/i.test(from) || fromAddr.endsWith('@resend.dev');

  const domainStatus = await probeResendDomains(apiKey);
  const fromDomain   = fromAddr.split('@')[1] || '';
  const matchingDomain = (domainStatus.domains || []).find((d) => d.name === fromDomain);

  const hints = [];
  if (!apiKey) hints.push('Set RESEND_API_KEY in backend/.env and restart the server.');
  if (sandbox) hints.push('MAIL_FROM is using the Resend sandbox sender — emails only deliver to the Resend account owner. Verify your domain and switch MAIL_FROM.');
  if (apiKey && !sandbox && matchingDomain && matchingDomain.status !== 'verified') {
    hints.push(`The "${fromDomain}" domain is "${matchingDomain.status}" on Resend — finish DNS verification before going live.`);
  }
  if (apiKey && !sandbox && !matchingDomain && !domainStatus.restricted) {
    hints.push(`No matching domain "${fromDomain}" on this Resend account. Add and verify it.`);
  }

  const ready =
    !!apiKey
    && !sandbox
    && (domainStatus.restricted || !!(matchingDomain && matchingDomain.status === 'verified'));

  res.json({
    ok:               true,
    resend_configured: !!apiKey,
    api_key_prefix:    apiKey ? `${apiKey.slice(0, 3)}…${apiKey.length} chars` : null,
    mail_from:         from,
    from_address:      fromAddr,
    from_domain:       fromDomain,
    sandbox,
    domain_status:     domainStatus,
    ready,
    hints,
  });
});

// POST /api/admin/mail-test  body: { to, subject? }
// Sends a single test email and reports back what Resend said. Returns 200
// regardless of outcome so the UI can render the diagnostic — only auth /
// validation failures use non-200 status codes.
app.post('/api/admin/mail-test', adminAuth, async (req, res) => {
  const to      = String(req.body?.to || '').trim();
  const subject = String(req.body?.subject || 'Gospelar mail health check').trim();
  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, error: 'Invalid recipient email.' });
  }
  const stampedSubject = subject + ' · ' + new Date().toISOString();
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:520px;margin:auto">
      <h2 style="margin:0 0 12px;color:#1A56DB">✓ Gospelar mail health check</h2>
      <p style="margin:0 0 10px;color:#0F172A;line-height:1.5">
        If you're reading this, the Resend pipeline from <code>${process.env.MAIL_FROM || 'default sender'}</code>
        is delivering correctly to <strong>${to}</strong>.
      </p>
      <p style="margin:0;color:#64748B;font-size:12.5px;line-height:1.5">
        Sent at ${new Date().toLocaleString('en-NG')} from the admin dashboard mail-test endpoint.
      </p>
    </div>
  `;
  const result = await sendMail({ to, subject: stampedSubject, html });
  res.json({
    ok:        result.ok,
    id:        result.id || null,
    error:     result.error || null,
    mail_from: process.env.MAIL_FROM || null,
    to,
    subject:   stampedSubject,
  });
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
        up.church, up.location
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
    if (req.church) {
      logActivity({
        church_id:   req.church.id,
        branch_id:   req.activeBranchId,
        actor_email: req.staff?.email,
        actor_name:  req.staff?.name,
        action:      'teacher.approved',
        entity_type: 'teacher',
        entity_id:   r.rows[0].id,
        summary:     `Approved teacher ${r.rows[0].full_name || r.rows[0].email}`,
      });
    }
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
    if (req.church) {
      logActivity({
        church_id:   req.church.id,
        branch_id:   req.activeBranchId,
        actor_email: req.staff?.email,
        actor_name:  req.staff?.name,
        action:      'teacher.rejected',
        entity_type: 'teacher',
        entity_id:   r.rows[0].id,
        summary:     `Rejected teacher ${r.rows[0].full_name || r.rows[0].email}${reason ? ` — ${reason}` : ''}`,
      });
    }
    res.json({ message: 'Rejected.', teacher: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/teachers/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Reject failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — BRANCHES, STAFF, ACTIVITY, ADMIN INSIGHTS
// All require x-church-key (or x-admin-key for super-admin). New for PDF #1.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/church-admin/me — bootstraps the dashboard with the church row,
// the current staff member, all the branches this church owns, and the
// active branch id (derived from request headers).
app.get('/api/church-admin/me', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const br = await db.query(
      `SELECT id, name, location, is_headquarters, created_at
         FROM branches
        WHERE church_id = $1
        ORDER BY is_headquarters DESC, name ASC`,
      [req.church.id],
    );
    const { admin_token, ...churchSafe } = req.church;
    res.json({
      church:         churchSafe,
      staff:          req.staff,
      branches:       br.rows,
      activeBranchId: req.activeBranchId,
    });
  } catch (e) {
    console.error('GET /api/church-admin/me:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// ── Branches ────────────────────────────────────────────────────────────────
app.get('/api/church-admin/branches', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const r = await db.query(
      `SELECT b.id, b.name, b.location, b.is_headquarters, b.created_at,
              (SELECT COUNT(*)::int FROM users         u WHERE u.branch_id = b.id) AS member_count,
              (SELECT COUNT(*)::int FROM classes       c WHERE c.branch_id = b.id) AS class_count,
              (SELECT COUNT(*)::int FROM activity_log  a WHERE a.branch_id = b.id
                 AND a.created_at > NOW() - INTERVAL '30 days')                    AS recent_activity
         FROM branches b
        WHERE b.church_id = $1
        ORDER BY b.is_headquarters DESC, b.name ASC`,
      [req.church.id],
    );
    res.json({ branches: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/branches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load branches.' });
  }
});

app.post('/api/church-admin/branches', churchAuth, requirePerm('branches', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const name = String(req.body?.name || '').trim();
  const location = String(req.body?.location || '').trim() || null;
  const isHq = !!req.body?.is_headquarters;
  if (!name) return res.status(400).json({ error: 'Branch name is required.' });
  try {
    if (isHq) {
      await db.query('UPDATE branches SET is_headquarters = FALSE WHERE church_id = $1', [req.church.id]);
    }
    const r = await db.query(
      `INSERT INTO branches (church_id, name, location, is_headquarters)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, location, is_headquarters, created_at`,
      [req.church.id, name, location, isHq],
    );
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'branch.created', entity_type: 'branch', entity_id: r.rows[0].id,
      summary: `Created branch ${name}`,
    });
    res.status(201).json({ branch: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A branch with this name already exists.' });
    console.error('POST /api/church-admin/branches:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create branch.' });
  }
});

app.put('/api/church-admin/branches/:id', churchAuth, requirePerm('branches', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const name = req.body?.name != null ? String(req.body.name).trim() : null;
  const location = req.body?.location != null ? (String(req.body.location).trim() || null) : null;
  const isHq = req.body?.is_headquarters;
  try {
    if (isHq === true) {
      await db.query('UPDATE branches SET is_headquarters = FALSE WHERE church_id = $1', [req.church.id]);
    }
    const r = await db.query(
      `UPDATE branches
          SET name            = COALESCE($1, name),
              location        = COALESCE($2, location),
              is_headquarters = COALESCE($3, is_headquarters)
        WHERE id = $4 AND church_id = $5
        RETURNING id, name, location, is_headquarters, created_at`,
      [name, location, typeof isHq === 'boolean' ? isHq : null, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Branch not found.' });
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'branch.updated', entity_type: 'branch', entity_id: r.rows[0].id,
      summary: `Updated branch ${r.rows[0].name}`,
    });
    res.json({ branch: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/branches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update branch.' });
  }
});

app.delete('/api/church-admin/branches/:id', churchAuth, requirePerm('branches', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    // Refuse if anything still points at this branch — keeps the data sane.
    const dep = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users   WHERE branch_id = $1) AS users,
         (SELECT COUNT(*)::int FROM classes WHERE branch_id = $1) AS classes`,
      [id],
    );
    const { users: uc, classes: cc } = dep.rows[0];
    if (uc > 0 || cc > 0) {
      return res.status(409).json({
        error: 'Branch has dependents.',
        members: uc,
        classes: cc,
        message: 'Reassign members and classes to another branch before deleting.',
      });
    }
    const r = await db.query(
      'DELETE FROM branches WHERE id = $1 AND church_id = $2 RETURNING id, name',
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Branch not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'branch.deleted', entity_type: 'branch', entity_id: id,
      summary: `Deleted branch ${r.rows[0].name}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/branches/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete branch.' });
  }
});

// ── Staff ───────────────────────────────────────────────────────────────────
app.get('/api/church-admin/staff', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const r = await db.query(
      `SELECT s.id, s.email, s.name, s.role, s.status, s.branch_id, s.created_at,
              b.name AS branch_name
         FROM staff s
         LEFT JOIN branches b ON b.id = s.branch_id
        WHERE s.church_id = $1
        ORDER BY s.role ASC, s.name ASC`,
      [req.church.id],
    );
    res.json({ staff: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/staff:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load staff.' });
  }
});

const STAFF_ROLES = ['super_admin','pastor','finance','worker','sunday_school_teacher','member'];

app.post('/api/church-admin/staff', churchAuth, requirePerm('staff', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const email = String(req.body?.email || '').toLowerCase().trim();
  const name  = String(req.body?.name  || '').trim() || null;
  const role  = String(req.body?.role  || 'worker');
  const branch_id = req.body?.branch_id ? parseInt(req.body.branch_id, 10) : null;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (branch_id != null && !Number.isFinite(branch_id)) return res.status(400).json({ error: 'Invalid branch_id.' });
  try {
    if (branch_id) {
      const b = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branch_id, req.church.id]);
      if (!b.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
    }
    const r = await db.query(
      `INSERT INTO staff (church_id, branch_id, email, name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'invited')
       RETURNING id, email, name, role, status, branch_id, created_at`,
      [req.church.id, branch_id, email, name, role],
    );
    logActivity({
      church_id: req.church.id, branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'staff.invited', entity_type: 'staff', entity_id: r.rows[0].id,
      summary: `Invited ${name || email} as ${role}`,
    });
    res.status(201).json({ staff: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Someone with this email is already on the roster.' });
    console.error('POST /api/church-admin/staff:', e.code, e.message);
    res.status(500).json({ error: 'Failed to invite staff.' });
  }
});

app.put('/api/church-admin/staff/:id', churchAuth, requirePerm('staff', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const role   = req.body?.role   != null ? String(req.body.role)   : null;
  const status = req.body?.status != null ? String(req.body.status) : null;
  const name   = req.body?.name   != null ? String(req.body.name).trim() || null : null;
  const branch_id = req.body?.branch_id !== undefined
    ? (req.body.branch_id == null ? null : parseInt(req.body.branch_id, 10))
    : undefined;
  if (role && !STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (status && !['active','invited','disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    if (branch_id) {
      const b = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branch_id, req.church.id]);
      if (!b.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
    }
    const r = await db.query(
      `UPDATE staff
          SET role      = COALESCE($1, role),
              status    = COALESCE($2, status),
              name      = COALESCE($3, name),
              branch_id = CASE WHEN $5::int = 1 THEN $4::int ELSE branch_id END
        WHERE id = $6 AND church_id = $7
        RETURNING id, email, name, role, status, branch_id, created_at`,
      [role, status, name, branch_id ?? null, branch_id !== undefined ? 1 : 0, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Staff not found.' });
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'staff.updated', entity_type: 'staff', entity_id: r.rows[0].id,
      summary: `Updated ${r.rows[0].name || r.rows[0].email} (${r.rows[0].role})`,
    });
    res.json({ staff: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/staff/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update staff.' });
  }
});

app.delete('/api/church-admin/staff/:id', churchAuth, requirePerm('staff', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    // Don't allow removing the church's own admin_email row — that would lock
    // the church out of its own dashboard.
    const r = await db.query(
      `DELETE FROM staff
        WHERE id = $1
          AND church_id = $2
          AND LOWER(email) <> LOWER((SELECT admin_email FROM churches WHERE id = $2))
        RETURNING id, email, name`,
      [id, req.church.id],
    );
    if (!r.rows.length) {
      return res.status(409).json({ error: 'Cannot remove the church admin.' });
    }
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'staff.removed', entity_type: 'staff', entity_id: id,
      summary: `Removed ${r.rows[0].name || r.rows[0].email}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/staff/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to remove staff.' });
  }
});

// ── Activity feed ──────────────────────────────────────────────────────────
// Cursor pagination: ?since_id=N returns rows with id > N (for "new since
// last poll"). Without since_id, returns the most recent `limit` rows.
app.get('/api/church-admin/activity', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const sinceId = req.query.since_id ? parseInt(req.query.since_id, 10) : null;
  const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
  try {
    const params = [req.church.id];
    let where = 'WHERE church_id = $1';
    if (req.activeBranchId) {
      params.push(req.activeBranchId);
      where += ` AND branch_id = $${params.length}`;
    }
    if (entityType) {
      params.push(entityType);
      where += ` AND entity_type = $${params.length}`;
    }
    let orderClause;
    if (Number.isFinite(sinceId)) {
      params.push(sinceId);
      where += ` AND id > $${params.length}`;
      orderClause = 'ORDER BY id ASC';   // ascending for "new since" so client can append
    } else {
      orderClause = 'ORDER BY id DESC';  // newest first for initial load
    }
    params.push(limit);
    const r = await db.query(
      `SELECT id, branch_id, actor_email, actor_name, action, entity_type, entity_id,
              summary, metadata, created_at
         FROM activity_log
         ${where}
         ${orderClause}
         LIMIT $${params.length}`,
      params,
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('GET /api/church-admin/activity:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load activity.' });
  }
});

// ── Admin summary KPIs — Members / Attendance / Engagement / Donations ─────
app.get('/api/church-admin/insights/admin-summary', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const cid = req.church.id;
  const bid = req.activeBranchId;
  const branchFilter = bid ? ' AND branch_id = $2' : '';
  const params = bid ? [cid, bid] : [cid];
  try {
    const [members, attendance, engagement] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM members
             WHERE church_id = $1${branchFilter}
               AND status IN ('member','first_timer')) AS members_total,
           (SELECT COUNT(*)::int FROM members
             WHERE church_id = $1${branchFilter}
               AND status IN ('member','first_timer')
               AND created_at >= date_trunc('month', NOW())) AS members_this_month,
           (SELECT COUNT(*)::int FROM members
             WHERE church_id = $1${branchFilter}
               AND status IN ('member','first_timer')
               AND created_at >= date_trunc('month', NOW() - INTERVAL '1 month')
               AND created_at <  date_trunc('month', NOW())) AS members_last_month`,
        params,
      ),
      db.query(
        `SELECT
           (SELECT COUNT(DISTINCT (class_id, lesson_number, student_email))::int FROM teacher_marks
             WHERE church_id = $1${branchFilter}
               AND awarded_at >= NOW() - INTERVAL '7 days')   AS attendance_this_week,
           (SELECT COUNT(DISTINCT (class_id, lesson_number, student_email))::int FROM teacher_marks
             WHERE church_id = $1${branchFilter}
               AND awarded_at >= NOW() - INTERVAL '14 days'
               AND awarded_at <  NOW() - INTERVAL '7 days')  AS attendance_last_week`,
        params,
      ),
      db.query(
        `SELECT
           (SELECT COUNT(*)::int
              FROM user_scores us
              JOIN class_members cm ON cm.student_email = us.email
              JOIN classes c        ON c.id = cm.class_id
             WHERE c.church_id = $1${bid ? ' AND c.branch_id = $2' : ''}
               AND us.completed_at >= NOW() - INTERVAL '7 days') AS lessons_7d,
           (SELECT COUNT(*)::int
              FROM user_scores us
              JOIN class_members cm ON cm.student_email = us.email
              JOIN classes c        ON c.id = cm.class_id
             WHERE c.church_id = $1${bid ? ' AND c.branch_id = $2' : ''}
               AND us.completed_at >= NOW() - INTERVAL '14 days'
               AND us.completed_at <  NOW() - INTERVAL '7 days') AS lessons_prev_7d`,
        params,
      ),
    ]);

    // Donations: finance tables don't exist yet (item #9). Return zeros so
    // the dashboard's KPI card renders without breaking.
    res.json({
      members: {
        total:      members.rows[0].members_total,
        this_month: members.rows[0].members_this_month,
        last_month: members.rows[0].members_last_month,
      },
      attendance: {
        this_week: attendance.rows[0].attendance_this_week,
        last_week: attendance.rows[0].attendance_last_week,
      },
      engagement: {
        lessons_7d:      engagement.rows[0].lessons_7d,
        lessons_prev_7d: engagement.rows[0].lessons_prev_7d,
      },
      donations: { last_30d: 0, prev_30d: 0, note: 'finance tables not yet provisioned' },
    });
  } catch (e) {
    console.error('GET /api/church-admin/insights/admin-summary:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load summary.' });
  }
});

// ── Member growth — daily new + cumulative for the chart ───────────────────
app.get('/api/church-admin/insights/member-growth', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const days = Math.min(parseInt(req.query.days, 10) || 180, 730);
  const cid = req.church.id;
  const bid = req.activeBranchId;
  const branchFilter = bid ? ' AND branch_id = $3' : '';
  const params = bid ? [String(days), cid, bid] : [String(days), cid];
  try {
    const daily = await db.query(
      `SELECT date_trunc('day', created_at)::date AS day,
              COUNT(*)::int AS joined
         FROM members
        WHERE church_id = $2${branchFilter}
          AND status IN ('member','first_timer')
          AND created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY day
        ORDER BY day ASC`,
      params,
    );
    // Compute the cumulative starting value (everything before the window).
    const startTotal = await db.query(
      `SELECT COUNT(*)::int AS total
         FROM members
        WHERE church_id = $2${branchFilter}
          AND status IN ('member','first_timer')
          AND created_at <  NOW() - ($1 || ' days')::interval`,
      params,
    );
    let running = startTotal.rows[0].total;
    const series = daily.rows.map((row) => {
      running += row.joined;
      return { day: row.day, joined: row.joined, cumulative: running };
    });
    res.json({ windowDays: days, startTotal: startTotal.rows[0].total, series });
  } catch (e) {
    console.error('GET /api/church-admin/insights/member-growth:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load member growth.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — MEMBERS, FAMILIES, WORKER ASSIGNMENTS (PDF item #2)
// ─────────────────────────────────────────────────────────────────────────────

const MEMBER_STATUSES   = ['visitor', 'first_timer', 'member', 'inactive'];
const FAMILY_ROLES      = ['head', 'spouse', 'child', 'dependent', 'other'];

// Returns the columns that are safe to round-trip to the client. Strips the
// photo_base64 unless `withPhoto` is true (photos can be megabytes; keep the
// list endpoint lean).
function memberCols(withPhoto = false) {
  return `m.id, m.church_id, m.branch_id, m.family_id, m.family_role,
          m.first_name, m.last_name, m.email, m.phone,
          m.gender, m.date_of_birth, m.marital_status, m.address,
          m.occupation, m.status, m.joined_at, m.notes,
          m.created_at, m.updated_at${withPhoto ? ', m.photo_base64' : ''}`;
}

// GET /api/church-admin/members
//   ?status=visitor|first_timer|member|inactive|all  (default: all)
//   ?branch_id=N            (otherwise inherited from x-branch-id header)
//   ?family_id=N
//   ?worker=true            (only members with at least one active assignment)
//   ?q=search-term          (name / email / phone)
//   ?limit=200 (max 500)
app.get('/api/church-admin/members', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const status = String(req.query.status || 'all').toLowerCase();
  if (status !== 'all' && !MEMBER_STATUSES.includes(status))
    return res.status(400).json({ error: 'Invalid status filter.' });

  const params = [req.church.id];
  let where = 'WHERE m.church_id = $1';

  // Branch filter: explicit query param wins, otherwise inherit from header.
  const branchId = req.query.branch_id != null
    ? parseInt(req.query.branch_id, 10)
    : req.activeBranchId;
  if (Number.isFinite(branchId) && branchId) {
    params.push(branchId);
    where += ` AND m.branch_id = $${params.length}`;
  }
  if (status !== 'all') {
    params.push(status);
    where += ` AND m.status = $${params.length}`;
  }
  if (req.query.family_id) {
    const fid = parseInt(req.query.family_id, 10);
    if (Number.isFinite(fid)) {
      params.push(fid);
      where += ` AND m.family_id = $${params.length}`;
    }
  }
  if (String(req.query.worker || '').toLowerCase() === 'true') {
    where += ` AND EXISTS (SELECT 1 FROM worker_assignments wa
                            WHERE wa.member_id = m.id AND wa.ended_at IS NULL)`;
  }
  if (req.query.q) {
    const term = `%${String(req.query.q).toLowerCase()}%`;
    params.push(term);
    where += ` AND (
      LOWER(m.first_name) LIKE $${params.length} OR
      LOWER(m.last_name)  LIKE $${params.length} OR
      LOWER(COALESCE(m.email, '')) LIKE $${params.length} OR
      COALESCE(m.phone, '') LIKE $${params.length}
    )`;
  }
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT ${memberCols(false)},
              f.name AS family_name,
              b.name AS branch_name,
              (SELECT COUNT(*)::int FROM worker_assignments wa
                WHERE wa.member_id = m.id AND wa.ended_at IS NULL) AS active_assignments
         FROM members m
         LEFT JOIN families f ON f.id = m.family_id
         LEFT JOIN branches b ON b.id = m.branch_id
         ${where}
         ORDER BY m.created_at DESC
         LIMIT $${params.length}`,
      params,
    );
    res.json({ members: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('GET /api/church-admin/members:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load members.' });
  }
});

// GET /api/church-admin/members/:id — full detail including photo + assignments
app.get('/api/church-admin/members/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const [memberR, assignR, familyR] = await Promise.all([
      db.query(
        `SELECT ${memberCols(true)},
                f.name AS family_name,
                b.name AS branch_name
           FROM members m
           LEFT JOIN families f ON f.id = m.family_id
           LEFT JOIN branches b ON b.id = m.branch_id
          WHERE m.id = $1 AND m.church_id = $2`,
        [id, req.church.id],
      ),
      db.query(
        `SELECT id, department, role, started_at, ended_at, notes, created_at
           FROM worker_assignments
          WHERE member_id = $1
          ORDER BY ended_at IS NULL DESC, started_at DESC`,
        [id],
      ),
      // Siblings if this member has a family.
      db.query(
        `SELECT id, first_name, last_name, family_role
           FROM members
          WHERE family_id = (SELECT family_id FROM members WHERE id = $1)
            AND family_id IS NOT NULL
            AND id <> $1
          ORDER BY family_role NULLS LAST, first_name`,
        [id],
      ),
    ]);
    if (!memberR.rows.length) return res.status(404).json({ error: 'Member not found.' });
    res.json({
      member:      memberR.rows[0],
      assignments: assignR.rows,
      family_members: familyR.rows,
    });
  } catch (e) {
    console.error('GET /api/church-admin/members/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load member.' });
  }
});

// Body fields accepted by POST and PUT. PUT uses COALESCE so missing fields
// don't overwrite existing data.
function memberBody(body) {
  return {
    first_name:     body.first_name != null ? String(body.first_name).trim() || null : undefined,
    last_name:      body.last_name  != null ? String(body.last_name).trim()  || null : undefined,
    email:          body.email      != null ? String(body.email).toLowerCase().trim() || null : undefined,
    phone:          body.phone      != null ? String(body.phone).trim() || null : undefined,
    gender:         body.gender     != null ? String(body.gender) || null : undefined,
    date_of_birth:  body.date_of_birth || null,
    marital_status: body.marital_status != null ? String(body.marital_status) || null : undefined,
    address:        body.address != null ? String(body.address) || null : undefined,
    occupation:     body.occupation != null ? String(body.occupation) || null : undefined,
    status:         body.status != null ? String(body.status) : undefined,
    joined_at:      body.joined_at || null,
    notes:          body.notes != null ? String(body.notes) || null : undefined,
    branch_id:      body.branch_id != null ? parseInt(body.branch_id, 10) : undefined,
    family_id:      body.family_id !== undefined
      ? (body.family_id == null ? null : parseInt(body.family_id, 10))
      : undefined,
    family_role:    body.family_role !== undefined
      ? (body.family_role == null ? null : String(body.family_role))
      : undefined,
  };
}

app.post('/api/church-admin/members', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const b = memberBody(req.body || {});
  if (!b.first_name) return res.status(400).json({ error: 'first_name is required.' });
  if (b.status && !MEMBER_STATUSES.includes(b.status))
    return res.status(400).json({ error: 'Invalid status.' });
  if (b.family_role && !FAMILY_ROLES.includes(b.family_role))
    return res.status(400).json({ error: 'Invalid family_role.' });

  // Branch defaults to the active branch from the header, or HQ if none.
  let branchId = b.branch_id;
  if (!branchId) {
    if (req.activeBranchId) {
      branchId = req.activeBranchId;
    } else {
      const hq = await db.query(
        `SELECT id FROM branches WHERE church_id = $1 AND is_headquarters = TRUE LIMIT 1`,
        [req.church.id],
      );
      branchId = hq.rows[0]?.id || null;
    }
  } else {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branchId, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
  }
  if (b.family_id) {
    const ok = await db.query('SELECT 1 FROM families WHERE id = $1 AND church_id = $2', [b.family_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Family not in your church.' });
  }

  try {
    const r = await db.query(
      `INSERT INTO members
        (church_id, branch_id, family_id, family_role,
         first_name, last_name, email, phone,
         gender, date_of_birth, marital_status, address, occupation,
         status, joined_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               COALESCE($14,'member'), COALESCE($15, CURRENT_DATE), $16)
       RETURNING ${memberCols(false).replace(/m\./g, '')}`,
      [
        req.church.id, branchId, b.family_id ?? null, b.family_role ?? null,
        b.first_name, b.last_name ?? null, b.email ?? null, b.phone ?? null,
        b.gender ?? null, b.date_of_birth, b.marital_status ?? null,
        b.address ?? null, b.occupation ?? null,
        b.status ?? null, b.joined_at, b.notes ?? null,
      ],
    );
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.created', entity_type: 'member', entity_id: m.id,
      summary: `Registered ${m.first_name} ${m.last_name || ''}`.trim() + ` as ${m.status}`,
    });
    res.status(201).json({ member: m });
  } catch (e) {
    console.error('POST /api/church-admin/members:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create member.' });
  }
});

app.put('/api/church-admin/members/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const b = memberBody(req.body || {});
  if (b.status && !MEMBER_STATUSES.includes(b.status))
    return res.status(400).json({ error: 'Invalid status.' });
  if (b.family_role && !FAMILY_ROLES.includes(b.family_role))
    return res.status(400).json({ error: 'Invalid family_role.' });
  if (b.branch_id) {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [b.branch_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
  }
  if (b.family_id) {
    const ok = await db.query('SELECT 1 FROM families WHERE id = $1 AND church_id = $2', [b.family_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Family not in your church.' });
  }
  try {
    const r = await db.query(
      `UPDATE members SET
         first_name     = COALESCE($1, first_name),
         last_name      = COALESCE($2, last_name),
         email          = COALESCE($3, email),
         phone          = COALESCE($4, phone),
         gender         = COALESCE($5, gender),
         date_of_birth  = COALESCE($6, date_of_birth),
         marital_status = COALESCE($7, marital_status),
         address        = COALESCE($8, address),
         occupation     = COALESCE($9, occupation),
         status         = COALESCE($10, status),
         joined_at      = COALESCE($11, joined_at),
         notes          = COALESCE($12, notes),
         branch_id      = COALESCE($13, branch_id),
         family_id      = CASE WHEN $15::int = 1 THEN $14::int ELSE family_id END,
         family_role    = CASE WHEN $17::int = 1 THEN $16 ELSE family_role END
       WHERE id = $18 AND church_id = $19
       RETURNING ${memberCols(false).replace(/m\./g, '')}`,
      [
        b.first_name ?? null, b.last_name ?? null, b.email ?? null, b.phone ?? null,
        b.gender ?? null, b.date_of_birth, b.marital_status ?? null,
        b.address ?? null, b.occupation ?? null, b.status ?? null,
        b.joined_at, b.notes ?? null, b.branch_id ?? null,
        b.family_id ?? null, b.family_id !== undefined ? 1 : 0,
        b.family_role ?? null, b.family_role !== undefined ? 1 : 0,
        id, req.church.id,
      ],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.updated', entity_type: 'member', entity_id: m.id,
      summary: `Updated ${m.first_name} ${m.last_name || ''}`.trim(),
    });
    res.json({ member: m });
  } catch (e) {
    console.error('PUT /api/church-admin/members/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update member.' });
  }
});

app.delete('/api/church-admin/members/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `DELETE FROM members WHERE id = $1 AND church_id = $2
       RETURNING id, first_name, last_name, branch_id`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.deleted', entity_type: 'member', entity_id: id,
      summary: `Removed ${m.first_name} ${m.last_name || ''}`.trim(),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/members/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete member.' });
  }
});

// Photo upload — accepts { photo_base64 } directly. The 10mb express.json limit
// (already configured at the top of the file) is the upper bound. Sending null
// clears the photo.
app.post('/api/church-admin/members/:id/photo', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const photo = req.body?.photo_base64;
  if (photo != null && typeof photo !== 'string')
    return res.status(400).json({ error: 'photo_base64 must be a data URL string or null.' });
  try {
    const r = await db.query(
      `UPDATE members SET photo_base64 = $1
        WHERE id = $2 AND church_id = $3
        RETURNING id`,
      [photo || null, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/church-admin/members/:id/photo:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save photo.' });
  }
});

// Convenience: visitor → first_timer → member promote shortcut.
app.post('/api/church-admin/members/:id/promote', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `UPDATE members SET status = CASE status
          WHEN 'visitor'     THEN 'first_timer'
          WHEN 'first_timer' THEN 'member'
          ELSE status
        END
        WHERE id = $1 AND church_id = $2
        RETURNING id, first_name, last_name, status, branch_id`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const m = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: m.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'member.promoted', entity_type: 'member', entity_id: m.id,
      summary: `${m.first_name} ${m.last_name || ''} promoted to ${m.status}`.trim(),
    });
    res.json({ member: m });
  } catch (e) {
    console.error('POST /api/church-admin/members/:id/promote:', e.code, e.message);
    res.status(500).json({ error: 'Promote failed.' });
  }
});

// ── Families ───────────────────────────────────────────────────────────────
app.get('/api/church-admin/families', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const params = [req.church.id];
  let where = 'WHERE f.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND (f.branch_id = $${params.length} OR f.branch_id IS NULL)`;
  }
  try {
    const r = await db.query(
      `SELECT f.id, f.name, f.address, f.branch_id, f.notes, f.created_at,
              b.name AS branch_name,
              h.id AS head_id, h.first_name AS head_first, h.last_name AS head_last,
              (SELECT COUNT(*)::int FROM members m WHERE m.family_id = f.id) AS member_count
         FROM families f
         LEFT JOIN branches b ON b.id = f.branch_id
         LEFT JOIN members  h ON h.id = f.head_member_id
         ${where}
         ORDER BY f.name ASC`,
      params,
    );
    res.json({ families: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/families:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load families.' });
  }
});

app.get('/api/church-admin/families/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const [fam, members] = await Promise.all([
      db.query(
        `SELECT f.*, b.name AS branch_name,
                h.first_name AS head_first, h.last_name AS head_last
           FROM families f
           LEFT JOIN branches b ON b.id = f.branch_id
           LEFT JOIN members  h ON h.id = f.head_member_id
          WHERE f.id = $1 AND f.church_id = $2`,
        [id, req.church.id],
      ),
      db.query(
        `SELECT id, first_name, last_name, family_role, phone, email, status, joined_at
           FROM members
          WHERE family_id = $1
          ORDER BY family_role NULLS LAST, first_name`,
        [id],
      ),
    ]);
    if (!fam.rows.length) return res.status(404).json({ error: 'Family not found.' });
    res.json({ family: fam.rows[0], members: members.rows });
  } catch (e) {
    console.error('GET /api/church-admin/families/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load family.' });
  }
});

app.post('/api/church-admin/families', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required.' });
  const address = req.body?.address != null ? String(req.body.address) || null : null;
  const notes   = req.body?.notes   != null ? String(req.body.notes)   || null : null;
  const branch_id = req.body?.branch_id != null
    ? parseInt(req.body.branch_id, 10)
    : (req.activeBranchId || null);
  if (branch_id) {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND church_id = $2', [branch_id, req.church.id]);
    if (!ok.rows.length) return res.status(400).json({ error: 'Branch not in your church.' });
  }
  try {
    const r = await db.query(
      `INSERT INTO families (church_id, branch_id, name, address, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, address, branch_id, notes, created_at`,
      [req.church.id, branch_id, name, address, notes],
    );
    logActivity({
      church_id: req.church.id, branch_id: r.rows[0].branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'family.created', entity_type: 'family', entity_id: r.rows[0].id,
      summary: `Created family ${r.rows[0].name}`,
    });
    res.status(201).json({ family: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/families:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create family.' });
  }
});

app.put('/api/church-admin/families/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const name    = req.body?.name    != null ? String(req.body.name).trim() : null;
  const address = req.body?.address != null ? String(req.body.address) || null : null;
  const notes   = req.body?.notes   != null ? String(req.body.notes)   || null : null;
  const head_member_id = req.body?.head_member_id !== undefined
    ? (req.body.head_member_id == null ? null : parseInt(req.body.head_member_id, 10))
    : undefined;
  try {
    // If switching the head, also make sure that member belongs to this family.
    if (head_member_id) {
      const ok = await db.query(
        `SELECT 1 FROM members WHERE id = $1 AND church_id = $2 AND family_id = $3`,
        [head_member_id, req.church.id, id],
      );
      if (!ok.rows.length) return res.status(400).json({ error: 'Head must already belong to this family.' });
    }
    const r = await db.query(
      `UPDATE families SET
         name           = COALESCE($1, name),
         address        = COALESCE($2, address),
         notes          = COALESCE($3, notes),
         head_member_id = CASE WHEN $5::int = 1 THEN $4::int ELSE head_member_id END
       WHERE id = $6 AND church_id = $7
       RETURNING id, name, address, branch_id, notes, head_member_id, created_at`,
      [name, address, notes, head_member_id ?? null, head_member_id !== undefined ? 1 : 0, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Family not found.' });
    // Mark the new head with family_role='head' too.
    if (head_member_id) {
      await db.query(
        `UPDATE members SET family_role = CASE WHEN id = $1 THEN 'head'
                                              WHEN family_role = 'head' THEN NULL
                                              ELSE family_role END
          WHERE family_id = $2`,
        [head_member_id, id],
      );
    }
    res.json({ family: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/families/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update family.' });
  }
});

app.delete('/api/church-admin/families/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    // ON DELETE SET NULL handles members.family_id; clear family_role too.
    await db.query(
      `UPDATE members SET family_role = NULL WHERE family_id = $1`,
      [id],
    );
    const r = await db.query(
      `DELETE FROM families WHERE id = $1 AND church_id = $2 RETURNING id, name`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Family not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'family.deleted', entity_type: 'family', entity_id: id,
      summary: `Deleted family ${r.rows[0].name}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/families/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete family.' });
  }
});

// ── Worker / volunteer assignments ─────────────────────────────────────────
// Lists all currently-active assignments grouped by department. Frontend
// renders one section per department with the members serving there.
app.get('/api/church-admin/workers', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const includeEnded = String(req.query.include_ended || 'false') === 'true';
  const params = [req.church.id];
  let where = `WHERE wa.church_id = $1${includeEnded ? '' : ' AND wa.ended_at IS NULL'}`;
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND (wa.branch_id = $${params.length} OR wa.branch_id IS NULL)`;
  }
  try {
    const r = await db.query(
      `SELECT wa.id, wa.department, wa.role, wa.started_at, wa.ended_at, wa.notes,
              wa.member_id, wa.branch_id,
              m.first_name, m.last_name, m.email, m.phone,
              b.name AS branch_name
         FROM worker_assignments wa
         JOIN members m  ON m.id = wa.member_id
         LEFT JOIN branches b ON b.id = wa.branch_id
         ${where}
         ORDER BY wa.department ASC, wa.started_at DESC`,
      params,
    );
    res.json({ assignments: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/workers:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load workers.' });
  }
});

app.post('/api/church-admin/members/:id/assignments', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isFinite(memberId)) return res.status(400).json({ error: 'Invalid member id.' });
  const department = String(req.body?.department || '').trim();
  const role       = String(req.body?.role || 'member').trim() || 'member';
  const startedAt  = req.body?.started_at || null;
  const notes      = req.body?.notes != null ? String(req.body.notes) || null : null;
  if (!department) return res.status(400).json({ error: 'department is required.' });
  try {
    const member = await db.query(
      `SELECT id, branch_id FROM members WHERE id = $1 AND church_id = $2`,
      [memberId, req.church.id],
    );
    if (!member.rows.length) return res.status(404).json({ error: 'Member not found.' });
    const r = await db.query(
      `INSERT INTO worker_assignments
        (member_id, church_id, branch_id, department, role, started_at, notes)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7)
       RETURNING id, department, role, started_at, ended_at, notes, member_id, branch_id, created_at`,
      [memberId, req.church.id, member.rows[0].branch_id, department, role, startedAt, notes],
    );
    logActivity({
      church_id: req.church.id, branch_id: member.rows[0].branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'worker.assigned', entity_type: 'worker', entity_id: r.rows[0].id,
      summary: `Assigned member #${memberId} to ${department} (${role})`,
    });
    res.status(201).json({ assignment: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/members/:id/assignments:', e.code, e.message);
    res.status(500).json({ error: 'Failed to assign.' });
  }
});

app.put('/api/church-admin/assignments/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const department = req.body?.department != null ? String(req.body.department).trim() : null;
  const role       = req.body?.role       != null ? String(req.body.role).trim() : null;
  const started_at = req.body?.started_at || null;
  const ended_at   = req.body?.ended_at !== undefined ? (req.body.ended_at || null) : undefined;
  const notes      = req.body?.notes != null ? String(req.body.notes) || null : null;
  try {
    const r = await db.query(
      `UPDATE worker_assignments SET
         department = COALESCE($1, department),
         role       = COALESCE($2, role),
         started_at = COALESCE($3, started_at),
         ended_at   = CASE WHEN $5::int = 1 THEN $4::date ELSE ended_at END,
         notes      = COALESCE($6, notes)
       WHERE id = $7 AND church_id = $8
       RETURNING id, department, role, started_at, ended_at, notes, member_id, branch_id, created_at`,
      [department, role, started_at, ended_at ?? null, ended_at !== undefined ? 1 : 0, notes, id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found.' });
    res.json({ assignment: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/church-admin/assignments/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update assignment.' });
  }
});

app.delete('/api/church-admin/assignments/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `DELETE FROM worker_assignments WHERE id = $1 AND church_id = $2
       RETURNING id, member_id, department`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'worker.unassigned', entity_type: 'worker', entity_id: id,
      summary: `Removed member #${r.rows[0].member_id} from ${r.rows[0].department}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/assignments/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to remove assignment.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — SUNDAY SCHOOL & LEARNING (PDF item #7)
// Read-only oversight of classes + students enrolled in the caller's church,
// plus manual certificate issue/list/revoke.
// ─────────────────────────────────────────────────────────────────────────────

const CERTIFICATE_TYPES = ['completion', 'excellence', 'attendance', 'memorization', 'custom'];

// GET /api/church-admin/learning/classes
// Lists every class in the caller's church (or active branch) with the
// teacher's name, enrollment count, most recent attendance, and lesson count.
app.get('/api/church-admin/learning/classes', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const params = [req.church.id];
  let where = 'WHERE c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND c.branch_id = $${params.length}`;
  }
  try {
    const r = await db.query(
      `SELECT c.id, c.name, c.category, c.invite_code, c.created_at,
              c.teacher_email,
              u.full_name AS teacher_name,
              u.approval_status AS teacher_status,
              (SELECT COUNT(*)::int FROM class_members cm WHERE cm.class_id = c.id)
                AS enrollment,
              (SELECT COUNT(DISTINCT (tm.lesson_number, tm.student_email))::int
                 FROM teacher_marks tm WHERE tm.class_id = c.id) AS attendance_count,
              (SELECT COUNT(DISTINCT tm.lesson_number)::int
                 FROM teacher_marks tm WHERE tm.class_id = c.id) AS lessons_taught,
              (SELECT MAX(tm.awarded_at) FROM teacher_marks tm WHERE tm.class_id = c.id)
                AS last_active_at
         FROM classes c
         LEFT JOIN users u ON LOWER(u.email) = LOWER(c.teacher_email)
         ${where}
         ORDER BY c.created_at DESC`,
      params,
    );
    res.json({ classes: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/learning/classes:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load classes.' });
  }
});

// GET /api/church-admin/learning/students
// Returns every student enrolled in any class of the caller's church, with
// score/attendance aggregates. Used by the certificate-issue picker.
//   ?q=...   — search by name/email
//   ?limit=N — caps results (default 100, max 500)
app.get('/api/church-admin/learning/students', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const term  = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
  const params = [req.church.id];
  if (req.activeBranchId) params.push(req.activeBranchId);
  const branchClause = req.activeBranchId ? ` AND c.branch_id = $2` : '';
  if (term) params.push(term);
  const termIdx = params.length;
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT DISTINCT cm.student_email,
              COALESCE(u.full_name, cm.student_email)              AS student_name,
              COUNT(DISTINCT cm.class_id)                          AS classes_count,
              (SELECT COUNT(*)::int FROM user_scores us
                 WHERE LOWER(us.email) = LOWER(cm.student_email))  AS lessons_completed,
              (SELECT COALESCE(SUM(us.score), 0)::int FROM user_scores us
                 WHERE LOWER(us.email) = LOWER(cm.student_email))  AS total_score,
              (SELECT COUNT(*)::int FROM teacher_marks tm
                 WHERE tm.church_id = $1
                   AND LOWER(tm.student_email) = LOWER(cm.student_email))
                                                                   AS marks_received,
              (SELECT MAX(us.completed_at) FROM user_scores us
                 WHERE LOWER(us.email) = LOWER(cm.student_email))  AS last_active
         FROM class_members cm
         JOIN classes c ON c.id = cm.class_id
         LEFT JOIN users u ON LOWER(u.email) = LOWER(cm.student_email)
        WHERE c.church_id = $1${branchClause}
          ${term ? `AND (LOWER(cm.student_email) LIKE $${termIdx} OR LOWER(COALESCE(u.full_name, '')) LIKE $${termIdx})` : ''}
        GROUP BY cm.student_email, u.full_name
        ORDER BY lessons_completed DESC NULLS LAST, student_name ASC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ students: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/learning/students:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load students.' });
  }
});

// ── Certificates ───────────────────────────────────────────────────────────
app.get('/api/church-admin/certificates', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const type        = req.query.type ? String(req.query.type) : null;
  const q           = req.query.q    ? String(req.query.q).toLowerCase() : null;
  const includeRevoked = String(req.query.include_revoked || 'false') === 'true';
  const params = [req.church.id];
  let where = 'WHERE church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND branch_id = $${params.length}`;
  }
  if (type) {
    if (!CERTIFICATE_TYPES.includes(type))
      return res.status(400).json({ error: 'Invalid certificate type.' });
    params.push(type);
    where += ` AND type = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (LOWER(student_name) LIKE $${params.length} OR LOWER(student_email) LIKE $${params.length} OR LOWER(title) LIKE $${params.length})`;
  }
  if (!includeRevoked) where += ` AND revoked_at IS NULL`;
  try {
    const r = await db.query(
      `SELECT id, student_email, student_name, type, title, body, context,
              certificate_no, awarded_by, awarded_at, revoked_at, branch_id
         FROM certificates
         ${where}
         ORDER BY awarded_at DESC
         LIMIT 500`,
      params,
    );
    res.json({ certificates: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/certificates:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load certificates.' });
  }
});

app.get('/api/church-admin/certificates/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `SELECT c.*, ch.name AS church_name, b.name AS branch_name
         FROM certificates c
         JOIN churches ch ON ch.id = c.church_id
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE c.id = $1 AND c.church_id = $2`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found.' });
    res.json({ certificate: r.rows[0] });
  } catch (e) {
    console.error('GET /api/church-admin/certificates/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load certificate.' });
  }
});

// CERT-2026-A1B2C3D4 — 8 random chars from a 32-char alphabet = ~10^12
// distinct numbers per year, collision-resistant even with the UNIQUE
// constraint acting as a hard guard. One INSERT, no transaction needed.
function makeCertNo() {
  const year = new Date().getFullYear();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 8; i++) rand += A[Math.floor(Math.random() * A.length)];
  return `CERT-${year}-${rand}`;
}

app.post('/api/church-admin/certificates', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const {
    student_email, student_name, type, title, body, context, awarded_at,
  } = req.body || {};
  if (!student_email || !isValidEmail(student_email))
    return res.status(400).json({ error: 'A valid student_email is required.' });
  if (!student_name?.trim())
    return res.status(400).json({ error: 'student_name is required.' });
  if (!type || !CERTIFICATE_TYPES.includes(type))
    return res.status(400).json({ error: `type must be one of ${CERTIFICATE_TYPES.join(', ')}.` });
  if (!title?.trim())
    return res.status(400).json({ error: 'title is required.' });
  try {
    const r = await db.query(
      `INSERT INTO certificates
         (church_id, branch_id, student_email, student_name, type, title, body,
          context, certificate_no, awarded_by, awarded_at)
       VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, $8::jsonb,
               $9, $10, COALESCE($11::timestamptz, NOW()))
       RETURNING *`,
      [
        req.church.id, req.activeBranchId, student_email, student_name.trim(),
        type, title.trim(), body || null,
        context ? JSON.stringify(context) : null,
        makeCertNo(),
        req.staff?.email || null, awarded_at || null,
      ],
    );
    logActivity({
      church_id: req.church.id, branch_id: req.activeBranchId,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'certificate.issued', entity_type: 'certificate', entity_id: r.rows[0].id,
      summary: `Issued ${type} certificate to ${student_name.trim()}`,
    });
    res.status(201).json({ certificate: r.rows[0] });
  } catch (e) {
    console.error('POST /api/church-admin/certificates:', e.code, e.message);
    res.status(500).json({ error: 'Failed to issue certificate.' });
  }
});

// Revoke (soft-delete by setting revoked_at). The certificate stays in the
// table so audit history is preserved; the UI hides revoked ones unless
// ?include_revoked=true is passed.
app.delete('/api/church-admin/certificates/:id', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `UPDATE certificates SET revoked_at = NOW()
        WHERE id = $1 AND church_id = $2 AND revoked_at IS NULL
        RETURNING id, student_name, type, branch_id`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found or already revoked.' });
    const c = r.rows[0];
    logActivity({
      church_id: req.church.id, branch_id: c.branch_id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'certificate.revoked', entity_type: 'certificate', entity_id: id,
      summary: `Revoked ${c.type} certificate for ${c.student_name}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/certificates/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to revoke certificate.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH ADMIN — SUNDAY SCHOOL MARKS (PDF item #7, marks pipeline)
// Collated view of every teacher_marks row written by the teacher mobile app.
// All queries JOIN through classes for the church/branch filter — that way
// rows that the teacher write path doesn't backfill with branch_id still get
// scoped correctly via the parent class.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/church-admin/marks
//   ?class_id=&lesson=&student_email=&mark_type=&awarded_by=
//   ?since_id=N        — cursor for live polling (returns rows with id > N, ASC)
//   ?limit=100         — capped at 500
// Without since_id, returns the newest rows DESC for an initial load.
app.get('/api/church-admin/marks', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const sinceId = req.query.since_id ? parseInt(req.query.since_id, 10) : null;
  const params = [req.church.id];
  let where = 'WHERE c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    where += ` AND c.branch_id = $${params.length}`;
  }
  if (req.query.class_id) {
    const cid = parseInt(req.query.class_id, 10);
    if (Number.isFinite(cid)) {
      params.push(cid);
      where += ` AND tm.class_id = $${params.length}`;
    }
  }
  if (req.query.lesson) {
    const ln = parseInt(req.query.lesson, 10);
    if (Number.isFinite(ln)) {
      params.push(ln);
      where += ` AND tm.lesson_number = $${params.length}`;
    }
  }
  if (req.query.student_email) {
    params.push(String(req.query.student_email).toLowerCase());
    where += ` AND LOWER(tm.student_email) = $${params.length}`;
  }
  if (req.query.mark_type) {
    params.push(String(req.query.mark_type));
    where += ` AND tm.mark_type = $${params.length}`;
  }
  if (req.query.awarded_by) {
    params.push(String(req.query.awarded_by).toLowerCase());
    where += ` AND LOWER(tm.awarded_by) = $${params.length}`;
  }
  let orderClause;
  if (Number.isFinite(sinceId)) {
    params.push(sinceId);
    where += ` AND tm.id > $${params.length}`;
    orderClause = 'ORDER BY tm.id ASC';   // ascending for "new since" so client appends
  } else {
    orderClause = 'ORDER BY tm.awarded_at DESC, tm.id DESC';
  }
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT tm.id, tm.class_id, tm.lesson_number, tm.student_email,
              tm.mark_type, tm.points, tm.note, tm.awarded_by, tm.awarded_at,
              c.name AS class_name, c.category AS class_category, c.invite_code,
              c.branch_id, b.name AS branch_name,
              COALESCE(u_student.full_name, tm.student_email) AS student_name,
              COALESCE(u_teacher.full_name, tm.awarded_by)    AS teacher_name
         FROM teacher_marks tm
         JOIN classes c           ON c.id = tm.class_id
         LEFT JOIN branches b     ON b.id = c.branch_id
         LEFT JOIN users u_student ON LOWER(u_student.email) = LOWER(tm.student_email)
         LEFT JOIN users u_teacher ON LOWER(u_teacher.email) = LOWER(tm.awarded_by)
         ${where}
         ${orderClause}
         LIMIT $${params.length}`,
      params,
    );
    res.json({ marks: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('GET /api/church-admin/marks:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load marks.' });
  }
});

// GET /api/church-admin/marks/summary
// 7-day vs prev 7-day deltas, top student / top class / top teacher (30d),
// mark-type breakdown (30d), recent activity day-by-day.
app.get('/api/church-admin/marks/summary', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const params = [req.church.id];
  let cFilter = 'c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    cFilter += ` AND c.branch_id = $${params.length}`;
  }
  try {
    const [windowed, byType, topStudent, topClass, topTeacher, daily] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '7 days')   AS marks_7d,
           (SELECT COUNT(*)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '14 days'
                                AND tm.awarded_at <  NOW() - INTERVAL '7 days') AS marks_prev_7d,
           (SELECT COALESCE(SUM(tm.points), 0)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '7 days')  AS points_7d,
           (SELECT COALESCE(SUM(tm.points), 0)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '14 days'
                                AND tm.awarded_at <  NOW() - INTERVAL '7 days') AS points_prev_7d,
           (SELECT COUNT(DISTINCT tm.awarded_by)::int FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
              WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days') AS active_teachers_30d`,
        params,
      ),
      db.query(
        `SELECT tm.mark_type AS type,
                COUNT(*)::int AS count,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY tm.mark_type
          ORDER BY count DESC`,
        params,
      ),
      db.query(
        `SELECT tm.student_email AS email,
                COALESCE(u.full_name, tm.student_email) AS name,
                COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm
           JOIN classes c ON c.id = tm.class_id
           LEFT JOIN users u ON LOWER(u.email) = LOWER(tm.student_email)
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY tm.student_email, u.full_name
          ORDER BY points DESC, marks DESC
          LIMIT 1`,
        params,
      ),
      db.query(
        `SELECT c.id, c.name, COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY c.id, c.name
          ORDER BY marks DESC
          LIMIT 1`,
        params,
      ),
      db.query(
        `SELECT tm.awarded_by AS email,
                COALESCE(u.full_name, tm.awarded_by) AS name,
                COUNT(*)::int AS marks
           FROM teacher_marks tm
           JOIN classes c ON c.id = tm.class_id
           LEFT JOIN users u ON LOWER(u.email) = LOWER(tm.awarded_by)
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY tm.awarded_by, u.full_name
          ORDER BY marks DESC
          LIMIT 1`,
        params,
      ),
      db.query(
        `SELECT date_trunc('day', tm.awarded_at)::date AS day,
                COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND tm.awarded_at >= NOW() - INTERVAL '30 days'
          GROUP BY day
          ORDER BY day ASC`,
        params,
      ),
    ]);
    res.json({
      windowed:   windowed.rows[0],
      byType:     byType.rows,
      topStudent: topStudent.rows[0] || null,
      topClass:   topClass.rows[0]   || null,
      topTeacher: topTeacher.rows[0] || null,
      daily:      daily.rows,
    });
  } catch (e) {
    console.error('GET /api/church-admin/marks/summary:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load summary.' });
  }
});

// GET /api/church-admin/marks/by-class/:classId
// Returns:
//   class:    { id, name, category, invite_code, teacher_email, teacher_name }
//   lessons:  [{ lesson_number, marks_count, total_points, last_awarded_at }]
//   students: [{ email, name,
//                lessons: { [lesson_number]: { marks, points, by_type: {...} } },
//                totals:  { marks, points } }]
app.get('/api/church-admin/marks/by-class/:classId', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const classId = parseInt(req.params.classId, 10);
  if (!Number.isFinite(classId)) return res.status(400).json({ error: 'Invalid class id.' });
  try {
    // Authorisation: the class must belong to this church.
    const cls = await db.query(
      `SELECT c.id, c.name, c.category, c.invite_code, c.teacher_email,
              u.full_name AS teacher_name
         FROM classes c
         LEFT JOIN users u ON LOWER(u.email) = LOWER(c.teacher_email)
        WHERE c.id = $1 AND c.church_id = $2`,
      [classId, req.church.id],
    );
    if (!cls.rows.length) return res.status(404).json({ error: 'Class not found.' });

    const [lessonsR, membersR, marksR] = await Promise.all([
      db.query(
        `SELECT lesson_number,
                COUNT(*)::int AS marks_count,
                COALESCE(SUM(points), 0)::int AS total_points,
                MAX(awarded_at) AS last_awarded_at
           FROM teacher_marks
          WHERE class_id = $1
          GROUP BY lesson_number
          ORDER BY lesson_number ASC`,
        [classId],
      ),
      db.query(
        `SELECT cm.student_email AS email,
                COALESCE(u.full_name, cm.student_email) AS name,
                cm.joined_at
           FROM class_members cm
           LEFT JOIN users u ON LOWER(u.email) = LOWER(cm.student_email)
          WHERE cm.class_id = $1
          ORDER BY name ASC`,
        [classId],
      ),
      db.query(
        `SELECT student_email, lesson_number, mark_type,
                COUNT(*)::int AS marks,
                COALESCE(SUM(points), 0)::int AS points
           FROM teacher_marks
          WHERE class_id = $1
          GROUP BY student_email, lesson_number, mark_type
          ORDER BY lesson_number, student_email`,
        [classId],
      ),
    ]);

    // Pivot into the students × lessons matrix shape the client expects.
    const studentMap = new Map();
    for (const m of membersR.rows) {
      studentMap.set(m.email.toLowerCase(), {
        email: m.email, name: m.name, joined_at: m.joined_at,
        lessons: {}, totals: { marks: 0, points: 0 },
      });
    }
    // Some marks may belong to students who left the class — include them
    // anyway so admins see the full picture.
    for (const m of marksR.rows) {
      const key = m.student_email.toLowerCase();
      if (!studentMap.has(key)) {
        studentMap.set(key, {
          email: m.student_email, name: m.student_email,
          joined_at: null, lessons: {}, totals: { marks: 0, points: 0 },
          left_class: true,
        });
      }
      const s = studentMap.get(key);
      const l = s.lessons[m.lesson_number] || { marks: 0, points: 0, by_type: {} };
      l.marks  += m.marks;
      l.points += m.points;
      l.by_type[m.mark_type] = (l.by_type[m.mark_type] || 0) + m.points;
      s.lessons[m.lesson_number] = l;
      s.totals.marks  += m.marks;
      s.totals.points += m.points;
    }
    const students = [...studentMap.values()]
      .sort((a, b) => b.totals.points - a.totals.points);

    res.json({
      class:    cls.rows[0],
      lessons:  lessonsR.rows,
      students,
    });
  } catch (e) {
    console.error('GET /api/church-admin/marks/by-class/:classId:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load class marks.' });
  }
});

// GET /api/church-admin/marks/by-student?email=
// Full scorecard for one student across all classes in this church.
app.get('/api/church-admin/marks/by-student', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email is required.' });
  const params = [req.church.id, email];
  let cFilter = 'c.church_id = $1';
  if (req.activeBranchId) {
    params.push(req.activeBranchId);
    cFilter += ` AND c.branch_id = $${params.length}`;
  }
  try {
    const [studentR, totalsR, byClassR, recentR, byTypeR] = await Promise.all([
      db.query(
        `SELECT u.email, COALESCE(u.full_name, u.email) AS name,
                u.role, u.approval_status, u.created_at
           FROM users u WHERE LOWER(u.email) = $1`,
        [email],
      ),
      db.query(
        `SELECT COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points,
                MIN(tm.awarded_at) AS first_awarded,
                MAX(tm.awarded_at) AS last_awarded
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2`,
        params,
      ),
      db.query(
        `SELECT c.id AS class_id, c.name AS class_name, c.category,
                COUNT(*)::int AS marks,
                COALESCE(SUM(tm.points), 0)::int AS points,
                COUNT(DISTINCT tm.lesson_number)::int AS lessons_covered,
                MAX(tm.awarded_at) AS last_awarded
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2
          GROUP BY c.id, c.name, c.category
          ORDER BY points DESC`,
        params,
      ),
      db.query(
        `SELECT tm.id, tm.class_id, c.name AS class_name,
                tm.lesson_number, tm.mark_type, tm.points, tm.note,
                tm.awarded_by, tm.awarded_at,
                COALESCE(u.full_name, tm.awarded_by) AS teacher_name
           FROM teacher_marks tm
           JOIN classes c ON c.id = tm.class_id
           LEFT JOIN users u ON LOWER(u.email) = LOWER(tm.awarded_by)
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2
          ORDER BY tm.awarded_at DESC
          LIMIT 50`,
        params,
      ),
      db.query(
        `SELECT tm.mark_type AS type,
                COUNT(*)::int AS count,
                COALESCE(SUM(tm.points), 0)::int AS points
           FROM teacher_marks tm JOIN classes c ON c.id = tm.class_id
          WHERE ${cFilter} AND LOWER(tm.student_email) = $2
          GROUP BY tm.mark_type
          ORDER BY count DESC`,
        params,
      ),
    ]);
    res.json({
      student: studentR.rows[0] || { email, name: email, role: null },
      totals:  totalsR.rows[0],
      byClass: byClassR.rows,
      byType:  byTypeR.rows,
      recent:  recentR.rows,
    });
  } catch (e) {
    console.error('GET /api/church-admin/marks/by-student:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load student scorecard.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DAILY READING TRACKER — streaks, XP, levels, badges
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints (all keyed on `email`, no token — same trust model as
// /api/quiz/submit and /api/progress/:email):
//
//   POST /api/reading/check-in           — record today, recompute streak + XP
//   GET  /api/reading/stats/:email       — full snapshot for the Stats screen
//   GET  /api/reading/calendar/:email    — last N days as a heatmap series
//   GET  /api/reading/leaderboard        — global or per-church ranking
//
// Streak rule: yesterday → +1, today → no-op, anything older → reset to 1.
// XP rules + badge predicates live below as constants so non-engineers can
// tweak them without re-reading the route logic.

const READING_XP = {
  CHECK_IN:        10,   // first check-in of the day
  PER_5_MIN:        5,   // each 5 min of reading time, capped
  TIME_BONUS_CAP:  20,   // max time-bonus XP per day
  BADGE_UNLOCK:    50,   // each new badge
};

// Each badge is unlocked the first time `predicate(stats)` flips true.
//   stats = { current_streak, longest_streak, total_days_read,
//             distinct_lessons_read, devotional_days, lifetime_xp }
const BADGE_CATALOG = [
  { id:'first_lesson',    title:'First Lesson Read',    emoji:'📖', desc:'Open and read a Sunday-school lesson for the first time.', predicate:(s) => s.total_days_read >= 1 },
  { id:'streak_3',        title:'Getting Started',      emoji:'✨', desc:'Read for 3 days in a row.', predicate:(s) => s.current_streak >= 3 },
  { id:'streak_7',        title:'7-Day Reader',         emoji:'🔥', desc:'A whole week of consecutive reading.', predicate:(s) => s.current_streak >= 7 },
  { id:'streak_30',       title:'Faithful Reader',      emoji:'💪', desc:'30 days in a row — a habit is forming.', predicate:(s) => s.current_streak >= 30 },
  { id:'streak_100',      title:'100-Day Disciple',     emoji:'👑', desc:'Three months of unbroken devotion.', predicate:(s) => s.current_streak >= 100 },
  { id:'genesis_unit',    title:'Genesis Completed',    emoji:'🌟', desc:'Read 13 distinct lessons — one quarter\'s worth.', predicate:(s) => s.distinct_lessons_read >= 13 },
  { id:'prayer_warrior',  title:'Prayer Warrior',       emoji:'🙏', desc:'30 days of devotional reading.', predicate:(s) => s.devotional_days >= 30 },
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

// Return all stats relevant to the badge predicates for a given email.
async function readingStatsCore(email) {
  const lc = email.toLowerCase();
  const profileR = await db.query(
    `SELECT COALESCE(current_streak,0) AS current_streak,
            COALESCE(longest_streak,0) AS longest_streak,
            last_read_date,
            COALESCE(lifetime_xp,0)    AS lifetime_xp,
            COALESCE(badges,'[]'::jsonb) AS badges
       FROM user_profiles WHERE email = $1`, [lc]);
  const p = profileR.rows[0] || { current_streak:0, longest_streak:0, last_read_date:null, lifetime_xp:0, badges:[] };

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

// POST /api/reading/check-in
// Body: { email, source_type?, lesson_id?, duration_seconds? }
//   source_type: 'lesson' (default) | 'devotional' | 'manual'
app.post('/api/reading/check-in', async (req, res) => {
  const { email, source_type, lesson_id, duration_seconds } = req.body || {};
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });
  const lc       = String(email).toLowerCase();
  const src      = ['lesson','devotional','manual'].includes(source_type) ? source_type : 'lesson';
  const lessonId = Number.isFinite(parseInt(lesson_id, 10)) ? parseInt(lesson_id, 10) : null;
  const dur      = Math.max(0, Math.min(parseInt(duration_seconds, 10) || 0, 4 * 3600));

  try {
    // Make sure user_profiles has a row for this email (so the gamification
    // columns are available to UPDATE).
    await db.query(
      `INSERT INTO user_profiles (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [lc]
    );

    // Was today already logged?
    const existR = await db.query(
      `SELECT id, duration_seconds FROM daily_reading_log
        WHERE email = $1 AND reading_date = CURRENT_DATE`, [lc]);

    let alreadyCheckedIn = false;
    let bonusXp = 0;

    if (existR.rows.length) {
      // Same-day → keep one row, but accumulate duration (capped) and award
      // any new time-bonus XP.
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
      // Fresh check-in for today.
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
      const today    = new Date(); today.setUTCHours(0,0,0,0);
      const yesterday = new Date(today); yesterday.setUTCDate(today.getUTCDate() - 1);
      if (lastDate && lastDate.toISOString().slice(0,10) === yesterday.toISOString().slice(0,10)) {
        streakInc = 1; // consecutive day
      } else {
        // Either first ever check-in OR a gap of ≥2 days → reset to 1
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

    // Re-evaluate badges and award any newly-unlocked ones (each pays out
    // BADGE_UNLOCK XP one time only).
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

// GET /api/reading/stats/:email
// Full snapshot for the Stats screen — one round trip on screen mount.
app.get('/api/reading/stats/:email', async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });
  try {
    // Make sure a profile row exists so the read-side returns sensible zeros
    // even for users who've never checked in.
    await db.query(`INSERT INTO user_profiles (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);

    const stats = await readingStatsCore(email);

    // Did the user check in today?
    const todayR = await db.query(
      `SELECT source_type, duration_seconds, lesson_id
         FROM daily_reading_log
        WHERE email = $1 AND reading_date = CURRENT_DATE`, [email]);

    // Last 14 log rows for the inline activity feed.
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

// GET /api/reading/calendar/:email?days=30
// Heatmap data — every day in the window, with a flag for whether the user
// checked in (and the source / minutes if they did).
app.get('/api/reading/calendar/:email', async (req, res) => {
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

// GET /api/reading/leaderboard?scope=global|church&days=7|30|all
// Default ranking: lifetime_xp DESC. For short windows the rank is the count
// of days the user checked in inside the window (so a brand-new but very
// active user can still climb).
app.get('/api/reading/leaderboard', async (req, res) => {
  const scope = req.query.scope === 'church' ? 'church' : 'global';
  const days  = req.query.days === 'all' ? null : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  // For church-scoped requests the caller must be a church admin (x-church-key)
  // so we can resolve the church_id. Use churchAuth's manual variant inline.
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
      // Lifetime ranking — straight off user_profiles.
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
      // Window-scoped ranking — count check-ins inside the window.
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

// Bulk import every translation row from backend/ui_translations.js — UPSERTs
// values, so re-running it overwrites with the latest source-of-truth strings.
// Use this after editing ui_translations.js (or shipping a new version) to
// push the new strings to the live DB without manual entry. The original
// /seed endpoint above only writes English placeholders + empty rows; this
// one writes real translated values for all four languages.
app.post('/api/admin/translations/import-from-source', adminAuth, async (req, res) => {
  try {
    // Lazy-require so the route file doesn't fail to load if the module is
    // momentarily missing during a deploy hot-swap.
    const { UI_TRANSLATIONS } = require('./ui_translations');

    // Filter out rows we wouldn't want to write. The previous version did
    // 1,464 sequential awaits which timed out on Railway's pooler — switch
    // to ONE multi-row INSERT so the whole import is a single round trip.
    const rows = UI_TRANSLATIONS.filter((tr) => tr.val != null && tr.val !== '');
    const skipped = UI_TRANSLATIONS.length - rows.length;

    if (rows.length === 0) {
      return res.json({ message: 'No rows to import.', total: UI_TRANSLATIONS.length, written: 0, skipped });
    }

    // Chunk to keep us well under Postgres' 65,535 parameter limit (3 cols × 1500 rows = 4,500).
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
    // `score` in user_scores is the sum of points earned (e.g., 4 correct × 10
    // pts = 40), NOT the count of correct answers. To compute percent we
    // therefore have to divide by the sum of question points, not the count
    // of questions. max_possible_score does that.
    const scores = await db.query(`
      SELECT us.lesson_id, us.score AS last_score, COALESCE(us.max_score,us.score) AS best_score,
             us.completed_at, l.lesson_number, l.title, l.topic, l.category_id,
             (SELECT COUNT(*) FROM lesson_quizzes WHERE lesson_id=us.lesson_id)::int AS total_questions,
             (SELECT COALESCE(SUM(points), 0) FROM lesson_quizzes WHERE lesson_id=us.lesson_id)::int AS max_possible_score
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
      lessons:rows.map(r=>{
        const best = parseInt(r.best_score, 10) || 0;
        const max  = parseInt(r.max_possible_score, 10) || 0;
        // Cap at 100 — if a question gets removed after submission, best can
        // exceed the new max and we don't want to surface > 100% in the UI.
        const pct  = max > 0 ? Math.min(100, Math.round((best / max) * 100)) : 0;
        return {
          lessonId:r.lesson_id, lessonNumber:r.lesson_number, title:r.title, topic:r.topic,
          categoryId:r.category_id, lastScore:parseInt(r.last_score,10), bestScore:best,
          totalQuestions:r.total_questions,
          maxPossibleScore:max,
          percent:pct,
          completedAt:r.completed_at,
        };
      }),
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
      'SELECT plan_id, price_kobo, COALESCE(price_usd_cents, 0) AS price_usd_cents, days FROM subscription_plans WHERE plan_id=$1',
      [planId]
    );
    if (r.rows[0]) return r.rows[0];
  } catch (e) { /* table may not exist on first run — fall through */ }
  return planId === 'all'
    ? { plan_id:'all',    price_kobo:100000, price_usd_cents: 0, days:SUBSCRIPTION_DAYS }
    : { plan_id:'single', price_kobo:50000,  price_usd_cents: 0, days:SUBSCRIPTION_DAYS };
}

// Public — frontend reads this on mount to populate price/days for every plan
// (subscription tiers + per-book SKUs). Returns price_usd_cents alongside the
// Naira amount so the mobile checkout can display the right currency per
// provider choice.
app.get('/api/subscription/plans', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT plan_id, price_kobo, COALESCE(price_usd_cents, 0) AS price_usd_cents,
              days, updated_at
         FROM subscription_plans
        ORDER BY price_kobo`
    );
    if (!r.rows.length) {
      return res.json([
        { plan_id:'single', price_kobo:50000,  price_usd_cents: 0, days:SUBSCRIPTION_DAYS },
        { plan_id:'all',    price_kobo:100000, price_usd_cents: 0, days:SUBSCRIPTION_DAYS },
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

// Admin — update price/days for any plan_id (subscription tier or book SKU).
// Accepts price_kobo (NGN smallest unit, required) and optional price_usd_cents
// for international Stripe checkout. plan_id is restricted by regex rather
// than an allow-list so newly-seeded book SKUs work without code changes.
app.put('/api/admin/subscription/plans/:planId', adminAuth, async (req, res) => {
  const planId = String(req.params.planId || '');
  if (!/^[a-z0-9_]{1,64}$/i.test(planId)) {
    return res.status(400).json({ error: 'plan_id must be 1-64 chars, lowercase letters, digits, or underscores.' });
  }
  const price_kobo = parseInt(req.body.price_kobo, 10);
  const days       = parseInt(req.body.days,       10);
  // Optional — only validated when present. Omitted means "leave USD price
  // alone", so admins editing just the Naira price don't accidentally wipe
  // a configured USD price.
  const hasUsd = req.body.price_usd_cents != null;
  const price_usd_cents = hasUsd ? parseInt(req.body.price_usd_cents, 10) : null;
  if (!Number.isFinite(price_kobo) || price_kobo < 100) {
    return res.status(400).json({ error:'price_kobo must be an integer ≥ 100 (i.e. ₦1).' });
  }
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return res.status(400).json({ error:'days must be an integer between 1 and 3650.' });
  }
  if (hasUsd && (!Number.isFinite(price_usd_cents) || price_usd_cents < 0 || price_usd_cents > 10_000_000)) {
    return res.status(400).json({ error: 'price_usd_cents must be an integer between 0 and 10,000,000.' });
  }
  try {
    // Build the UPDATE SET clause dynamically so the USD column is only
    // touched when the caller supplied it.
    const setParts = ['price_kobo = EXCLUDED.price_kobo', 'days = EXCLUDED.days', 'updated_at = NOW()'];
    if (hasUsd) setParts.push('price_usd_cents = EXCLUDED.price_usd_cents');
    const r = await db.query(`
      INSERT INTO subscription_plans (plan_id, price_kobo, price_usd_cents, days, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (plan_id) DO UPDATE SET
        ${setParts.join(',\n        ')}
      RETURNING *
    `, [planId, price_kobo, hasUsd ? price_usd_cents : 0, days]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/subscription/plans:', e.message);
    res.status(500).json({ error:'Failed to update plan.' });
  }
});

// Parse the comma-separated subscribed_books column into a clean array.
// Trims, lowercases, drops empties — defensive because admin tools may edit it.
const parseBooks = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// Append a book id (de-duped) to the existing comma-separated list.
const addBookToList = (raw, bookId) => {
  const set = new Set(parseBooks(raw));
  set.add(String(bookId).toLowerCase());
  return Array.from(set).join(',');
};

// ── Payment provider helpers ────────────────────────────────────────────────
// Three providers: Paystack (NGN, default), Flutterwave (NGN, alt), Stripe
// (USD, international). Each returns a uniform shape so the init endpoint
// doesn't have to branch on provider downstream:
//   { ok: true,  authorization_url, reference, raw }
//   { ok: false, code, message, status, raw }
// The "reference" we return is what the frontend hands back to /verify-payment.
// Stripe uses its session id as the reference; Flutterwave uses tx_ref.

const PROVIDERS = ['paystack', 'flutterwave', 'stripe'];

async function initPaystack({ email, pricing, planId, reference, metadata, callbackUrl }) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return { ok: false, code: 'paystack_key_missing', message: 'Paystack key not configured on server.' };
  }
  try {
    const r = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email, amount: pricing.price_kobo, currency: 'NGN',
        reference, callback_url: callbackUrl, metadata,
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } },
    );
    const d = r.data?.data;
    if (!d?.authorization_url) {
      return { ok: false, code: 'paystack_no_url', message: 'Paystack did not return an authorization URL.', raw: r.data };
    }
    return { ok: true, authorization_url: d.authorization_url, reference: d.reference, raw: d };
  } catch (e) {
    return paymentErrorOut('paystack', e);
  }
}

async function initFlutterwave({ email, pricing, planId, reference, metadata, callbackUrl }) {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) {
    return { ok: false, code: 'flutterwave_key_missing', message: 'Flutterwave key not configured on server.' };
  }
  try {
    // Flutterwave amounts are in major units (Naira), not kobo.
    const r = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref:       reference,
        amount:       pricing.price_kobo / 100,
        currency:     'NGN',
        redirect_url: callbackUrl,
        customer:     { email },
        customizations: { title: 'Gospelar', description: `Subscription: ${planId}` },
        meta:         metadata,
      },
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' } },
    );
    const link = r.data?.data?.link;
    if (!link) {
      return { ok: false, code: 'flutterwave_no_url', message: 'Flutterwave did not return a payment link.', raw: r.data };
    }
    return { ok: true, authorization_url: link, reference, raw: r.data?.data };
  } catch (e) {
    return paymentErrorOut('flutterwave', e);
  }
}

async function initStripe({ email, pricing, planId, reference, metadata, callbackUrl }) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, code: 'stripe_key_missing', message: 'Stripe key not configured on server.' };
  }
  if (!pricing.price_usd_cents || pricing.price_usd_cents < 50) {
    // Stripe's minimum charge is $0.50; also the admin may not have set a
    // USD price yet for this plan.
    return {
      ok: false, code: 'stripe_no_usd_price',
      message: `No USD price configured for "${planId}". Set price_usd_cents in the admin Pricing page (must be ≥ 50¢).`,
    };
  }
  try {
    // Stripe Checkout Sessions use form-urlencoded, not JSON. We build the
    // body by hand rather than pulling in the Stripe SDK as a new dependency.
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('customer_email', email);
    params.append('success_url', `${callbackUrl}?provider=stripe&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url',  `${callbackUrl}?provider=stripe&cancelled=1`);
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(pricing.price_usd_cents));
    params.append('line_items[0][price_data][product_data][name]', `Gospelar — ${planId}`);
    params.append('client_reference_id', reference);
    Object.entries(metadata || {}).forEach(([k, v]) => {
      if (v != null) params.append(`metadata[${k}]`, String(v));
    });

    const r = await axios.post(
      'https://api.stripe.com/v1/checkout/sessions',
      params.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    const session = r.data;
    if (!session?.url) {
      return { ok: false, code: 'stripe_no_url', message: 'Stripe did not return a Checkout URL.', raw: session };
    }
    // For Stripe, the reference the frontend hands back must be the session
    // id (Stripe verifies sessions by id, not by our tx_ref).
    return { ok: true, authorization_url: session.url, reference: session.id, raw: session };
  } catch (e) {
    return paymentErrorOut('stripe', e);
  }
}

function paymentErrorOut(provider, e) {
  const status = e?.response?.status || 500;
  const upstream = e?.response?.data?.message || e?.response?.data?.error?.message || e?.response?.data || e.message;
  console.error(`[${provider}]`, status, typeof upstream === 'string' ? upstream : JSON.stringify(upstream));
  return {
    ok: false,
    code: status === 401 ? `${provider}_auth` : `${provider}_init_failed`,
    message: status === 401
      ? `Payment provider rejected credentials. Check ${provider.toUpperCase()}_SECRET_KEY.`
      : `Failed to initialize ${provider} payment. Please try again.`,
    status,
    detail: typeof upstream === 'string' ? upstream : JSON.stringify(upstream),
  };
}

// POST /api/payments/initialize
// Server-side payment session creation. Frontend posts
//   { email, plan, category?, book_id?, provider? }
// where provider ∈ { paystack | flutterwave | stripe }, defaulting to
// 'paystack' for backwards compat. Server resolves the right amount from
// the subscription_plans table (price never trusted from the client),
// then hands off to the matching provider helper. Returns
//   { status:'success', authorization_url, reference, provider, ... }
// The mobile WebView opens authorization_url and intercepts the callback.
app.post('/api/payments/initialize', async (req, res) => {
  const { email, plan = 'single', category = 'adult', book_id = null } = req.body || {};
  const rawProvider = String(req.body?.provider || 'paystack').toLowerCase();
  const provider = PROVIDERS.includes(rawProvider) ? rawProvider : 'paystack';

  if (!email)               return res.status(400).json({ status: 'error', code: 'missing_email',   message: 'email required.' });
  if (!isValidEmail(email)) return res.status(400).json({ status: 'error', code: 'invalid_email', message: 'Invalid email.' });

  // Resolve the SKU. Per-book purchases use 'book_<slug>'; otherwise it's
  // the legacy single/all category plan.
  const safeBookId = book_id && /^[a-z0-9_]{3,64}$/i.test(String(book_id))
    ? String(book_id).toLowerCase() : null;
  const planId = safeBookId
    ? `book_${safeBookId}`
    : (plan === 'all' ? 'all' : 'single');
  const safeCategory = VALID_CATS.includes(category) ? category : 'adult';

  let pricing;
  try {
    pricing = await getPlanPricing(planId);
  } catch (e) {
    pricing = {
      price_kobo:      safeBookId ? 50000 : (planId === 'all' ? 100000 : 50000),
      price_usd_cents: 0,
      days:            safeBookId ? 365 : 300,
    };
  }

  // Reference includes provider + planId so server-side logs are easy to
  // grep when something goes wrong on a specific SKU.
  const reference = `Gospelar_${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${provider}_${planId}`.slice(0, 100);

  const PUBLIC_BASE = process.env.PUBLIC_API_URL
    || `${req.protocol}://${req.get('host')}`;
  const callbackUrl = `${PUBLIC_BASE.replace(/\/$/, '')}/api/payments/callback`;

  const metadata = {
    plan_id:  planId,
    category: planId === 'all' || safeBookId ? null : safeCategory,
    book_id:  safeBookId,
    provider,
  };
  const callArgs = { email: email.toLowerCase(), pricing, planId, reference, metadata, callbackUrl };

  let result;
  if      (provider === 'flutterwave') result = await initFlutterwave(callArgs);
  else if (provider === 'stripe')      result = await initStripe(callArgs);
  else                                 result = await initPaystack({
    ...callArgs,
    // Paystack supports its own metadata shape with custom_fields — pass them
    // through here so the dashboard view stays useful for that provider.
    metadata: {
      ...metadata,
      custom_fields: [
        { display_name: 'Plan',     variable_name: 'plan_id',  value: planId },
        { display_name: 'Category', variable_name: 'category', value: safeBookId ? '—' : safeCategory },
      ],
    },
  });

  if (!result.ok) {
    const httpCode = result.status === 401 ? 400 : 502;
    return res.status(httpCode).json({
      status: 'error',
      code:    result.code,
      message: result.message,
      detail:  result.detail || null,
      provider,
    });
  }

  res.json({
    status:            'success',
    provider,
    authorization_url: result.authorization_url,
    reference:         result.reference,
    amount_kobo:       pricing.price_kobo,
    amount_usd_cents:  pricing.price_usd_cents,
    plan_id:           planId,
    category:          safeBookId ? null : safeCategory,
    book_id:           safeBookId,
  });
});

// GET /api/payments/callback?reference=…
// Paystack redirects the user's WebView here after a successful payment.
// The mobile app's WebView intercepts this URL via onNavigationStateChange,
// reads the `reference` query param, and calls /api/verify-payment with it.
// We just render a tiny "Payment received" page so the user sees something
// in the brief moment between Paystack closing and the app verifying.
app.get('/api/payments/callback', (req, res) => {
  const ref = String(req.query.reference || req.query.trxref || '');
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment received</title>
<style>html,body{margin:0;height:100%;background:#0F172A;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;}
.b{text-align:center;max-width:320px;padding:24px;}
.s{width:64px;height:64px;border:5px solid rgba(255,255,255,.18);border-top-color:#10B981;border-radius:50%;animation:spin .9s linear infinite;margin:0 auto 18px;}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:18px;margin:0 0 8px;font-weight:800}
p{font-size:13px;color:rgba(255,255,255,.6);margin:0;line-height:1.5}</style>
</head><body><div class="b">
<div class="s"></div>
<h1>Payment received</h1>
<p>Verifying with Paystack — your subscription will activate in a moment.</p>
</div></body></html>`);
});

// ── Verify helpers — uniform { ok, amount_kobo, customer_email } shape ─────
async function verifyPaystack(reference) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return { ok: false, code: 'paystack_key_missing', message: 'Paystack not configured.' };
  }
  try {
    const r = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
    );
    const txn = r.data?.data;
    if (!txn) return { ok: false, code: 'paystack_no_data', message: 'Paystack returned no transaction for this reference.' };
    if (txn.status !== 'success') {
      return {
        ok: false, code: 'txn_not_successful',
        message: `Transaction status is "${txn.status || 'unknown'}". Only successful charges can be verified.`,
        gateway_response: txn.gateway_response || null,
      };
    }
    return {
      ok: true,
      amount_kobo: txn.amount,
      customer_email: (txn.customer?.email || '').toLowerCase(),
      currency: txn.currency || 'NGN',
      raw: txn,
    };
  } catch (e) { return paymentErrorOut('paystack', e); }
}

async function verifyFlutterwave(reference) {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) {
    return { ok: false, code: 'flutterwave_key_missing', message: 'Flutterwave not configured.' };
  }
  try {
    const r = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } },
    );
    const txn = r.data?.data;
    if (!txn) return { ok: false, code: 'flutterwave_no_data', message: 'Flutterwave returned no transaction for this reference.' };
    if (txn.status !== 'successful') {
      return {
        ok: false, code: 'txn_not_successful',
        message: `Transaction status is "${txn.status || 'unknown'}".`,
      };
    }
    return {
      ok: true,
      amount_kobo: Math.round((Number(txn.amount) || 0) * 100), // FW reports NGN whole units
      customer_email: (txn.customer?.email || '').toLowerCase(),
      currency: txn.currency || 'NGN',
      raw: txn,
    };
  } catch (e) { return paymentErrorOut('flutterwave', e); }
}

async function verifyStripe(sessionId, planPriceKobo) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, code: 'stripe_key_missing', message: 'Stripe not configured.' };
  }
  try {
    const r = await axios.get(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } },
    );
    const session = r.data;
    if (!session) return { ok: false, code: 'stripe_no_data', message: 'Stripe returned no session for this id.' };
    if (session.payment_status !== 'paid') {
      return {
        ok: false, code: 'txn_not_successful',
        message: `Stripe payment_status is "${session.payment_status || 'unknown'}".`,
      };
    }
    return {
      ok: true,
      // For DB consistency we record the NGN baseline price from the plan.
      // The actual USD charge is captured in `amount_usd_cents`.
      amount_kobo:      planPriceKobo || 0,
      amount_usd_cents: session.amount_total,
      customer_email:   (session.customer_email || session.customer_details?.email || '').toLowerCase(),
      currency:         (session.currency || 'usd').toUpperCase(),
      raw:              session,
    };
  } catch (e) { return paymentErrorOut('stripe', e); }
}

// Detect provider for back-compat: explicit body.provider wins; otherwise the
// reference shape gives it away (Stripe session ids start with `cs_`; our
// own references for paystack/flutterwave embed the provider name in slot 4).
function detectProvider(req) {
  const explicit = String(req.body?.provider || '').toLowerCase();
  if (PROVIDERS.includes(explicit)) return explicit;
  const ref = String(req.body?.reference || '');
  if (/^cs_(test|live)_/i.test(ref)) return 'stripe';
  const parts = ref.split('_');
  if (parts[3] && PROVIDERS.includes(parts[3].toLowerCase())) return parts[3].toLowerCase();
  return 'paystack'; // legacy default
}

app.post('/api/verify-payment', async (req, res) => {
  const { reference, email, category='adult', book_id=null } = req.body;
  if (!reference||!email) return res.status(400).json({ status:'error', message:'reference and email required.' });
  if (!isValidEmail(email)) return res.status(400).json({ status:'error', message:'Invalid email.' });
  const userEmail    = email.toLowerCase();
  const safeCategory = VALID_CATS.includes(category) ? category : 'adult';
  const provider     = detectProvider(req);
  // Book-SKU path: when a book_id is present, this is a per-book purchase
  // (Victory Month Prayer etc.) and we resolve pricing via the book's
  // dedicated plan row instead of the single/all category plans.
  const safeBookId   = book_id && /^[a-z0-9_]{3,64}$/i.test(String(book_id))
    ? String(book_id).toLowerCase()
    : null;
  try {
    // Stripe needs the plan's price_kobo upfront so the verify helper can
    // record a sensible NGN-baseline amount on rows that were actually
    // paid in USD. Resolve early; falls back gracefully.
    let planForBase;
    if (provider === 'stripe') {
      const planId = safeBookId ? `book_${safeBookId}` : (safeCategory === 'all' ? 'all' : 'single');
      planForBase = await getPlanPricing(planId).catch(() => null);
    }

    let v;
    if      (provider === 'flutterwave') v = await verifyFlutterwave(reference);
    else if (provider === 'stripe')      v = await verifyStripe(reference, planForBase?.price_kobo || 0);
    else                                 v = await verifyPaystack(reference);

    if (!v.ok) {
      const httpCode = v.status === 401 ? 400 : (v.status === 404 ? 400 : 400);
      return res.status(httpCode).json({
        status:  'error',
        code:    v.code,
        message: v.message,
        gateway_response: v.gateway_response || null,
        provider,
      });
    }

    if (v.customer_email && v.customer_email !== userEmail) {
      return res.status(400).json({
        status: 'error', code: 'email_mismatch',
        message: `Payment email (${v.customer_email}) doesn't match the account email (${userEmail}).`,
      });
    }

    // Backwards-compatible: reuse the paystack_ref column for any provider's
    // reference. It's just an opaque unique string. Renaming the column is
    // a separate refactor.
    const dup = await db.query('SELECT * FROM subscribers WHERE paystack_ref=$1', [reference]);
    if (dup.rows.length) return res.json({ status:'success', data:dup.rows[0] });
    // Shim — downstream code below was originally written against Paystack's
    // shape (txn.amount, txn.customer.email). Adapt the uniform verify-helper
    // result so the existing INSERT logic keeps working unchanged.
    const txn = { amount: v.amount_kobo, customer: { email: v.customer_email }, status: 'success' };

    if (safeBookId) {
      // Per-book SKU. Bug history:
      //   • On INSERT, subscribed_category was unspecified → DB DEFAULT 'adult'
      //     kicked in → a book-only buyer accidentally got Sunday-School Adult
      //     access for free.
      //   • On UPDATE, plan_type was overwritten → a Sunday-School subscriber
      //     buying a book lost their SS plan_type ('single'/'all').
      // Fix: explicit NULL category on fresh rows; preserve an existing
      //      Sunday-School plan_type; take the later of the two expiries.
      const planId   = `book_${safeBookId}`;
      const plan     = await getPlanPricing(planId).catch(() => ({ price_kobo: 50000, days: 365 }));
      const now      = new Date(), exp = addDays(now, plan.days);
      const priceKobo = txn.amount || plan.price_kobo;
      const existing = await db.query('SELECT subscribed_books FROM subscribers WHERE email=$1', [userEmail]);
      const newBooks = addBookToList(existing.rows[0]?.subscribed_books, safeBookId);
      const r = await db.query(`
        INSERT INTO subscribers
          (email,is_active,subscription_date,expiry_date,paystack_ref,
           subscribed_books,price_kobo,plan_type,subscribed_category)
        VALUES ($1,TRUE,$2,$3,$4,$5,$6,$7,NULL)
        ON CONFLICT (email) DO UPDATE SET
          is_active         = TRUE,
          subscription_date = EXCLUDED.subscription_date,
          expiry_date       = GREATEST(subscribers.expiry_date, EXCLUDED.expiry_date),
          paystack_ref      = EXCLUDED.paystack_ref,
          subscribed_books  = EXCLUDED.subscribed_books,
          price_kobo        = EXCLUDED.price_kobo,
          -- Preserve a Sunday-School plan_type if the buyer already had one;
          -- otherwise record the book plan. Never let a book purchase strip
          -- a paying Sunday-School subscriber of their plan.
          plan_type         = CASE
                                WHEN subscribers.plan_type IN ('single','all')
                                  THEN subscribers.plan_type
                                ELSE EXCLUDED.plan_type
                              END,
          -- subscribed_category is INTENTIONALLY omitted from the SET list so
          -- existing Sunday-School category survives, and a fresh book-only
          -- buyer doesn't inherit the DEFAULT 'adult' from the column spec.
          updated_at        = NOW()
        RETURNING *
      `, [userEmail, now, exp, reference, newBooks, priceKobo, planId]);
      console.log('[Sub] Activated %s → book:%s plan:%s', userEmail, safeBookId, planId);
      return res.json({
        status:'success', success:true, expiry_date:r.rows[0].expiry_date,
        book_id: safeBookId, plan_type: r.rows[0].plan_type, price_kobo: priceKobo,
        subscribed_books: parseBooks(newBooks),
        subscribed_category: r.rows[0].subscribed_category, data: r.rows[0],
      });
    }

    // Category SKU (Sunday School) — original behavior.
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
      subscribed_category:safeCategory, plan_type:planType, price_kobo:priceKobo,
      subscribed_books: parseBooks(r.rows[0].subscribed_books),
      data:r.rows[0],
    });
  } catch (e) {
    // Provider HTTP errors are caught inside the verify helpers above; this
    // catch only fires for unexpected failures (DB write, etc.).
    console.error('verify-payment:', e?.code || '(no code)', e?.message || '(no message)');
    res.status(500).json({
      status:  'error',
      code:    'verify_failed',
      message: 'Failed to verify payment. Please try again.',
      detail:  e?.message || null,
    });
  }
});

// Used by the app's SubscriptionContext. Older clients still POST here for
// category purchases. New clients use /api/verify-payment which also handles
// per-book SKUs. We accept `book_id` here too for forward-compat and route
// to the book-purchase shape so the bug fix is honoured regardless of which
// endpoint the client picks.
app.post('/api/subscription/verify', async (req, res) => {
  const { reference, email, category='adult', book_id=null } = req.body;
  if (!reference||!email) return res.status(400).json({ success:false, message:'Missing reference or email' });
  const safeBookId = book_id && /^[a-z0-9_]{3,64}$/i.test(String(book_id))
    ? String(book_id).toLowerCase()
    : null;
  try {
    const pRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers:{ Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY||''}` } }
    );
    if (!pRes.data.status||pRes.data.data?.status!=='success')
      return res.json({ success:false, message:'Payment not confirmed by Paystack.' });

    // Per-book branch — mirrors /api/verify-payment so the leakage fix
    // applies on this endpoint too.
    if (safeBookId) {
      const planId   = `book_${safeBookId}`;
      const plan     = await getPlanPricing(planId).catch(() => ({ price_kobo: 50000, days: 365 }));
      const exp      = new Date(); exp.setDate(exp.getDate()+plan.days);
      const expiry   = exp.toISOString();
      const priceKobo= plan.price_kobo;
      const existing = await db.query('SELECT subscribed_books FROM subscribers WHERE email=$1', [email]);
      const newBooks = addBookToList(existing.rows[0]?.subscribed_books, safeBookId);
      await db.query(`
        INSERT INTO subscribers
          (email,is_active,expiry_date,paystack_ref,subscription_date,
           subscribed_books,plan_type,price_kobo,subscribed_category)
        VALUES ($1,TRUE,$2,$3,NOW(),$4,$5,$6,NULL)
        ON CONFLICT (email) DO UPDATE SET
          is_active        = TRUE,
          expiry_date      = GREATEST(subscribers.expiry_date, EXCLUDED.expiry_date),
          paystack_ref     = EXCLUDED.paystack_ref,
          subscription_date= NOW(),
          subscribed_books = EXCLUDED.subscribed_books,
          plan_type        = CASE
                               WHEN subscribers.plan_type IN ('single','all')
                                 THEN subscribers.plan_type
                               ELSE EXCLUDED.plan_type
                             END,
          price_kobo       = EXCLUDED.price_kobo,
          updated_at       = NOW()
      `, [email, expiry, reference, newBooks, planId, priceKobo]);
      console.log('✅ subscription/verify: %s → book:%s', email, safeBookId);
      return res.json({
        success:true, expiry_date:expiry, plan_type:planId,
        book_id:safeBookId, subscribed_books: parseBooks(newBooks),
      });
    }

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
             subscribed_books,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [req.params.email]);
    if (!r.rows.length) return res.json({ active:false, expiry_date:null, subscribed_books:[] });
    const sub = r.rows[0];
    let days_remaining = null;
    if (sub.expiry_date) {
      days_remaining = Math.max(0, Math.ceil((new Date(sub.expiry_date)-new Date())/86400000));
    }
    return res.json({
      active:sub.active===true, expiry_date:sub.expiry_date, days_remaining,
      subscribed_category:sub.subscribed_category||'adult',
      plan_type:sub.plan_type||'single', price_kobo:sub.price_kobo||50000,
      // Parsed array of book IDs the user has paid for. Empty if they only
      // bought the legacy category-based Sunday School plans.
      subscribed_books: parseBooks(sub.subscribed_books),
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

// Authoritative server-side gate for per-book SKUs (Victory Month Prayer etc.).
// Sibling to /can-access/:categoryId — different scope, different reasons.
app.get('/api/subscription/can-access-book/:email/:bookId', async (req, res) => {
  const { email, bookId } = req.params;
  if (!email || !bookId) return res.status(400).json({ canAccess:false, reason:'missing_params' });
  try {
    const r = await db.query(`
      SELECT is_active, expiry_date, subscribed_books,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [email]);
    if (!r.rows.length) return res.json({ canAccess:false, reason:'no_subscription' });
    const sub = r.rows[0];
    if (!sub.active) return res.json({ canAccess:false, reason:'expired' });
    const books   = parseBooks(sub.subscribed_books);
    const owned   = books.includes(String(bookId).toLowerCase());
    return res.json({
      canAccess: owned,
      reason: owned ? 'book_owned' : 'not_purchased',
      subscribed_books: books,
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
             subscribed_category,plan_type,price_kobo,paystack_ref,
             subscribed_books, created_at,updated_at
      FROM subscribers ORDER BY created_at DESC
    `);
    res.json({
      count: r.rows.length,
      subscribers: r.rows.map((s) => ({ ...s, subscribed_books: parseBooks(s.subscribed_books) })),
    });
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
// LIBRARY — books catalog + per-book daily entries
// Public reads (no auth) match the trust model of /api/lessons.
// Admin writes are gated by the existing adminAuth middleware.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/books — list of books for the library.
// By default returns only available books, ordered by sort_order then id.
// Pass ?include=unavailable to return everything (admin/debug).
app.get('/api/books', async (req, res) => {
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

// GET /api/books/:slug — single book metadata.
app.get('/api/books/:slug', async (req, res) => {
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

// GET /api/books/:slug/entries — list of entries (lightweight, for the day-selector).
// Returns id, entry_number, entry_type, focus, scripture_text, entry_date — no
// long-form fields. Use GET /api/books/:slug/entries/:number for the full row.
app.get('/api/books/:slug/entries', async (req, res) => {
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

// GET /api/books/:slug/entries/:number?type=daily — full content of one entry.
// Defaults type to 'daily'; pass ?type=family_vigil etc. for vigil sessions.
app.get('/api/books/:slug/entries/:number', async (req, res) => {
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

// POST /api/admin/books — create a book.
app.post('/api/admin/books', adminAuth, async (req, res) => {
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

// PUT /api/admin/books/:id — update metadata. Any field may be omitted.
app.put('/api/admin/books/:id', adminAuth, async (req, res) => {
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
      // translations is JSONB — stringify so we can cast in the SET clause.
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

// POST /api/admin/books/:id/entries — upsert one entry. Same endpoint handles
// both create (new entry_number) and edit (existing one) via ON CONFLICT.
// This is what the seed-victory-month.js script uses too.
app.post('/api/admin/books/:id/entries', adminAuth, async (req, res) => {
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

// POST /api/admin/books/:slug/seed — bulk upsert. Admin sends an array of
// entries (and optional `meta` patch for the books row) and we run the same
// INSERT … ON CONFLICT DO UPDATE used by the single-entry endpoint inside a
// transaction, so a partial failure leaves the table unchanged. Replaces a
// loop of 36 individual POSTs the admin would otherwise have to make to
// import the bundled Victory Month content the first time.
app.post('/api/admin/books/:slug/seed', adminAuth, async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const { meta, entries } = req.body || {};
  if (!slug)                  return res.status(400).json({ error: 'slug is required.' });
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries[] is required.' });

  const client = await db.connect ? await db.connect() : null;
  // Some db wrappers expose .connect() (pg.Pool) and some only .query() (lite
  // wrappers). Fall back to non-transactional mode when no client is available
  // — the upserts are still idempotent per row, so the worst case is a partial
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

// DELETE /api/admin/books/:id/entries/:number?type=daily — remove one entry.
app.delete('/api/admin/books/:id/entries/:number', adminAuth, async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL MEDIA BROADCAST
// Lets a church connect social accounts and push a single flyer + caption to
// all of them at once. Facebook Page is fully wired; Instagram / X / WhatsApp
// store credentials but defer real publishing to their adapter stubs in
// services/socialPublishers.js (replace stub bodies when keys are ready).
// ─────────────────────────────────────────────────────────────────────────────
const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'twitter', 'whatsapp'];

// Strip tokens before returning an account row to the client.
function safeAccount(row) {
  if (!row) return row;
  return {
    id:            row.id,
    platform:      row.platform,
    account_label: row.account_label,
    external_id:   row.external_id,
    meta:          row.meta || {},
    status:        row.status,
    connected_by:  row.connected_by,
    created_at:    row.created_at,
    updated_at:    row.updated_at,
    has_token:     !!row.access_token,
  };
}

// GET /api/church-admin/social/accounts — what platforms are connected.
app.get('/api/church-admin/social/accounts', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  try {
    const r = await db.query(
      `SELECT * FROM social_accounts WHERE church_id = $1 ORDER BY platform ASC`,
      [req.church.id],
    );
    res.json({ accounts: r.rows.map(safeAccount) });
  } catch (e) {
    console.error('GET /api/church-admin/social/accounts:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load social accounts.' });
  }
});

// POST /api/church-admin/social/accounts
// Body: { platform, account_label, external_id?, access_token, refresh_token?, meta? }
// Upserts the (church, platform) pair. We don't run OAuth here — the church
// admin pastes credentials they obtained from each platform's dev portal.
app.post('/api/church-admin/social/accounts', churchAuth, requirePerm('social', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const platform = String(req.body?.platform || '').toLowerCase().trim();
  if (!SOCIAL_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${SOCIAL_PLATFORMS.join(', ')}` });
  }
  const accessToken = String(req.body?.access_token || '').trim();
  if (!accessToken) return res.status(400).json({ error: 'access_token is required.' });

  const accountLabel = req.body?.account_label ? String(req.body.account_label).trim() : null;
  const externalId   = req.body?.external_id   ? String(req.body.external_id).trim()   : null;
  const refreshToken = req.body?.refresh_token ? String(req.body.refresh_token).trim() : null;
  const meta         = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};

  try {
    const r = await db.query(
      `INSERT INTO social_accounts
         (church_id, platform, account_label, external_id, access_token, refresh_token, meta, connected_by, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',NOW())
       ON CONFLICT (church_id, platform) DO UPDATE
         SET account_label = EXCLUDED.account_label,
             external_id   = EXCLUDED.external_id,
             access_token  = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             meta          = EXCLUDED.meta,
             connected_by  = EXCLUDED.connected_by,
             status        = 'active',
             updated_at    = NOW()
       RETURNING *`,
      [req.church.id, platform, accountLabel, externalId, accessToken, refreshToken,
       JSON.stringify(meta), req.staff?.email || null],
    );
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'social.connected', entity_type: 'social_account', entity_id: r.rows[0].id,
      summary: `Connected ${platform}${accountLabel ? ` (${accountLabel})` : ''}`,
    });
    res.status(201).json({ account: safeAccount(r.rows[0]) });
  } catch (e) {
    console.error('POST /api/church-admin/social/accounts:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save social account.' });
  }
});

// DELETE /api/church-admin/social/accounts/:id — disconnect a platform.
app.delete('/api/church-admin/social/accounts/:id', churchAuth, requirePerm('social', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await db.query(
      `DELETE FROM social_accounts WHERE id = $1 AND church_id = $2 RETURNING platform, account_label`,
      [id, req.church.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found.' });
    logActivity({
      church_id: req.church.id,
      actor_email: req.staff?.email, actor_name: req.staff?.name,
      action: 'social.disconnected', entity_type: 'social_account', entity_id: id,
      summary: `Disconnected ${r.rows[0].platform}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/church-admin/social/accounts/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to disconnect account.' });
  }
});

// GET /api/church-admin/social/posts — broadcast history (newest first).
app.get('/api/church-admin/social/posts', churchAuth, async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const r = await db.query(
      `SELECT id, branch_id, caption, platforms, results, status,
              scheduled_at, published_at, created_by, created_at, image_mime,
              CASE WHEN image_base64 IS NULL THEN NULL
                   ELSE 'data:' || image_mime || ';base64,' || image_base64
              END AS image_data_url
         FROM social_posts
        WHERE church_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.church.id, limit],
    );
    res.json({ posts: r.rows });
  } catch (e) {
    console.error('GET /api/church-admin/social/posts:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load post history.' });
  }
});

// GET /api/social/media/:id — public flyer host. Returns the stored image
// bytes so platforms that *require* a fetchable URL (Instagram, and the
// faster path for Facebook) can pull the flyer without us having to upload
// it as multipart. Anyone with the numeric id can fetch; flyers are public
// announcements so that's intentional. Add a signed-token gate later if you
// ever store something more sensitive.
app.get('/api/social/media/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
  try {
    const r = await db.query(
      `SELECT image_base64, image_mime FROM social_posts WHERE id = $1`,
      [id],
    );
    if (!r.rows.length || !r.rows[0].image_base64) return res.status(404).send('Not found');
    const buf = Buffer.from(r.rows[0].image_base64, 'base64');
    res.set('Content-Type',  r.rows[0].image_mime || 'image/jpeg');
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('GET /api/social/media/:id:', e.code, e.message);
    res.status(500).send('Failed to load image');
  }
});

// Resolve the public base URL the platforms will hit when fetching flyers.
// Preference order:
//   1. process.env.PUBLIC_API_URL — explicit, recommended for production.
//   2. req.protocol + Host header — works in dev, falls down behind proxies.
//   3. null — no public URL available; FB falls back to multipart, IG fails.
function publicApiBase(req) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host  = req.get?.('host');
    if (host) return `${proto}://${host}`;
  }
  return null;
}

// Internal dispatcher used by both the POST endpoint and the scheduled-post
// worker. Takes a row already persisted to social_posts (status will be
// flipped to 'publishing' before dispatch and 'published'|'partial'|'failed'
// after) and runs every requested platform in parallel. Returns
// { results, status } so the caller can shape its response.
async function dispatchSocialPost({ postRow, churchId, branchId, actor, baseUrl, providedPublicUrl }) {
  const platforms = Array.isArray(postRow.platforms)
    ? postRow.platforms
    : (typeof postRow.platforms === 'string' ? JSON.parse(postRow.platforms || '[]') : []);

  // Mark as publishing so a concurrent worker run doesn't pick it up.
  await db.query(
    `UPDATE social_posts SET status = 'publishing', updated_at = NOW() WHERE id = $1`,
    [postRow.id],
  );

  let accounts;
  try {
    const a = await db.query(
      `SELECT * FROM social_accounts
        WHERE church_id = $1 AND platform = ANY($2::text[]) AND status = 'active'`,
      [churchId, platforms],
    );
    accounts = Object.fromEntries(a.rows.map(row => [row.platform, row]));
  } catch (e) {
    console.error('dispatchSocialPost (accounts):', e.code, e.message);
    await db.query(
      `UPDATE social_posts SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [postRow.id],
    );
    return { results: {}, status: 'failed' };
  }

  // Compute the public flyer URL the publishers can hand to FB/IG. Prefer
  // an explicitly-provided URL (caller is bringing their own host), else
  // fall back to our public route.
  const publicImageUrl = providedPublicUrl
    || (postRow.image_base64 && baseUrl ? `${baseUrl}/api/social/media/${postRow.id}` : null);

  const post = {
    image_base64:     postRow.image_base64,
    image_mime:       postRow.image_mime,
    caption:          postRow.caption,
    public_image_url: publicImageUrl,
  };

  const dispatches = await Promise.all(platforms.map(async (p) => {
    const acct = accounts[p];
    if (!acct) return [p, { ok: false, error: `${p} is not connected. Connect it first.` }];
    try {
      const out = await publishToPlatform(p, acct, post);
      return [p, out];
    } catch (err) {
      return [p, { ok: false, error: err?.message || 'Publisher threw' }];
    }
  }));
  const results = Object.fromEntries(dispatches);
  const allOk   = dispatches.every(([, v]) => v?.ok);
  const anyOk   = dispatches.some(([, v]) => v?.ok);
  const finalStatus = allOk ? 'published' : anyOk ? 'partial' : 'failed';

  try {
    await db.query(
      `UPDATE social_posts
          SET results = $1, status = $2, published_at = NOW(), updated_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(results), finalStatus, postRow.id],
    );
  } catch (e) {
    console.error('dispatchSocialPost (update):', e.code, e.message);
  }

  logActivity({
    church_id: churchId, branch_id: branchId || null,
    actor_email: actor?.email, actor_name: actor?.name,
    action: 'social.posted', entity_type: 'social_post', entity_id: postRow.id,
    summary: `Broadcast flyer to ${platforms.join(', ')} (${finalStatus})`,
    metadata: { platforms, status: finalStatus, scheduled: !!postRow.scheduled_at },
  });

  return { results, status: finalStatus };
}

// POST /api/church-admin/social/posts
// Body: { image_base64, image_mime?, caption?, platforms:[...], scheduled_at?,
//         public_image_url? }
// If scheduled_at is in the future, the row is saved with status='scheduled'
// and not published yet (the scheduler picks it up). Otherwise it dispatches
// to every requested platform in parallel and stores per-platform results.
app.post('/api/church-admin/social/posts', churchAuth, requirePerm('social', 'edit'), async (req, res) => {
  if (!req.church) return res.status(400).json({ error: 'super-admin call — no church scope' });

  const imageBase64 = req.body?.image_base64 ? String(req.body.image_base64) : null;
  const imageMime   = String(req.body?.image_mime || 'image/jpeg');
  const caption     = req.body?.caption != null ? String(req.body.caption) : '';
  const publicUrl   = req.body?.public_image_url ? String(req.body.public_image_url) : null;
  const platforms   = Array.isArray(req.body?.platforms)
    ? req.body.platforms.map(p => String(p).toLowerCase()).filter(p => SOCIAL_PLATFORMS.includes(p))
    : [];
  const scheduledAt = req.body?.scheduled_at ? new Date(req.body.scheduled_at) : null;

  if (!imageBase64 && !publicUrl) {
    return res.status(400).json({ error: 'Provide image_base64 or public_image_url.' });
  }
  if (!platforms.length) {
    return res.status(400).json({ error: 'Select at least one platform.' });
  }
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduled_at.' });
  }

  const isFuture = scheduledAt && scheduledAt.getTime() > Date.now() + 60_000;
  const initialStatus = isFuture ? 'scheduled' : 'publishing';

  let postRow;
  try {
    const r = await db.query(
      `INSERT INTO social_posts
         (church_id, branch_id, image_base64, image_mime, caption, platforms,
          status, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, status, scheduled_at, created_at, image_base64, image_mime, caption, platforms`,
      [req.church.id, req.activeBranchId || null, imageBase64, imageMime, caption,
       JSON.stringify(platforms), initialStatus,
       scheduledAt && isFuture ? scheduledAt : null, req.staff?.email || null],
    );
    postRow = r.rows[0];
  } catch (e) {
    console.error('POST /api/church-admin/social/posts (insert):', e.code, e.message);
    return res.status(500).json({ error: 'Failed to queue post.' });
  }

  // Scheduled in the future → just return; the worker will publish.
  if (isFuture) {
    return res.status(202).json({ post: { ...postRow, image_base64: undefined, platforms, results: {} } });
  }

  const baseUrl = publicApiBase(req);
  const { results, status: finalStatus } = await dispatchSocialPost({
    postRow,
    churchId:  req.church.id,
    branchId:  req.activeBranchId,
    actor:     req.staff,
    baseUrl,
    providedPublicUrl: publicUrl,
  });

  res.status(201).json({
    post: {
      id:           postRow.id,
      status:       finalStatus,
      platforms,
      results,
      created_at:   postRow.created_at,
      published_at: new Date().toISOString(),
    },
  });
});

// ─── Scheduled-post worker ──────────────────────────────────────────────────
// Once a minute, look for due `scheduled` posts and publish them. The dispatch
// helper flips status to `publishing` before fan-out, so even if this fires
// on two replicas the first one wins (the second sees no rows).
//
// Disable with SOCIAL_SCHEDULER=off (useful for tests / one-off scripts).
async function runSocialScheduler() {
  if (process.env.SOCIAL_SCHEDULER === 'off') return;
  let due;
  try {
    const r = await db.query(
      `SELECT id, church_id, branch_id, image_base64, image_mime, caption,
              platforms, scheduled_at, created_by
         FROM social_posts
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 10`,
    );
    due = r.rows;
  } catch (e) {
    console.error('socialScheduler (select):', e.code, e.message);
    return;
  }
  for (const row of due) {
    try {
      await dispatchSocialPost({
        postRow:  row,
        churchId: row.church_id,
        branchId: row.branch_id,
        actor:    { email: row.created_by, name: null },
        baseUrl:  publicApiBase(null),
        providedPublicUrl: null,
      });
    } catch (e) {
      console.error('socialScheduler (dispatch):', row.id, e.message);
    }
  }
}
setInterval(runSocialScheduler, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));