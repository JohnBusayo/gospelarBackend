// db/initSchema.js
// Idempotent DB schema setup. Each step is a SEPARATE array element so a
// partly-migrated database can keep going past the first failure (e.g. an
// "already exists" error on one CREATE doesn't block the rest). Safe to
// re-run on every boot.

const db = require('../db');

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

    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS subscribed_category VARCHAR(20) DEFAULT 'adult'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan_type           VARCHAR(64) DEFAULT 'single'`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS price_kobo          INTEGER     DEFAULT 50000`,
    `ALTER TABLE subscribers ALTER COLUMN plan_type TYPE VARCHAR(64)`,
    `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS subscribed_books    TEXT        DEFAULT ''`,

    // ── 2026-05 fix: prevent the DEFAULT 'adult' on subscribed_category from
    //    leaking Sunday-School access to users who only bought a book.
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
    `ALTER TABLE subscription_plans ALTER COLUMN plan_id TYPE VARCHAR(64)`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_usd_cents INTEGER NOT NULL DEFAULT 0`,
    `INSERT INTO subscription_plans (plan_id, price_kobo, days) VALUES
       ('single', 50000,  300),
       ('all',    100000, 300),
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
    //    each church has one admin.
    `CREATE TABLE IF NOT EXISTS churches (
      id           SERIAL       PRIMARY KEY,
      name         VARCHAR(200) NOT NULL,
      location     VARCHAR(200),
      admin_email  VARCHAR(255) NOT NULL,
      admin_token  VARCHAR(80)  NOT NULL,
      invite_code  VARCHAR(20)  UNIQUE NOT NULL,
      created_at   TIMESTAMPTZ  DEFAULT NOW()
    )`,

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
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS password_hash      TEXT`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS contact_name       VARCHAR(150)`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS phone              VARCHAR(50)`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS approval_status    VARCHAR(20) DEFAULT 'approved'`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS rejected_reason    TEXT`,
    `ALTER TABLE churches ADD COLUMN IF NOT EXISTS rejected_at        TIMESTAMPTZ`,

    // ── Teacher approval — church admin authorizes new teachers ──────────────
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status   VARCHAR(20) DEFAULT 'approved'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by_email VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_reason   TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at       TIMESTAMPTZ`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'churches_admin_email_key'
       ) THEN
         ALTER TABLE churches ADD CONSTRAINT churches_admin_email_key UNIQUE (admin_email);
       END IF;
     END $$`,

    // ── Daily reading tracker (streaks + XP + badges) ────────────────────────
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

    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS current_streak INT  DEFAULT 0`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS longest_streak INT  DEFAULT 0`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_read_date  DATE`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS lifetime_xp     INT  DEFAULT 0`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS badges          JSONB DEFAULT '[]'::jsonb`,

    // ── Library: books catalog + per-book daily entries ──────────────────────
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

    // ── Library + Victory Month: per-row translations ────────────────────────
    `ALTER TABLE books         ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE book_entries  ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}'::jsonb`,

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

    // ── Multi-branch support ────────────────────────────────────────────────
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

    // ── Staff roster ────────────────────────────────────────────────────────
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

    // ── Activity log ────────────────────────────────────────────────────────
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

    // ── Auto-seed an HQ branch + pastor staff row for each existing church ──
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

    // ── Member management ───────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS families (
       id              SERIAL       PRIMARY KEY,
       church_id       INT          NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
       branch_id       INT          REFERENCES branches(id) ON DELETE SET NULL,
       name            VARCHAR(200) NOT NULL,
       head_member_id  INT,
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
       family_role     VARCHAR(20),
       first_name      VARCHAR(120)  NOT NULL,
       last_name       VARCHAR(120),
       email           VARCHAR(255),
       phone           VARCHAR(50),
       gender          VARCHAR(10),
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

    // ── Worker / volunteer assignments ──────────────────────────────────────
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

    `DROP TRIGGER IF EXISTS members_updated_at ON members`,
    `CREATE TRIGGER members_updated_at
       BEFORE UPDATE ON members
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,
    `DROP TRIGGER IF EXISTS families_updated_at ON families`,
    `CREATE TRIGGER families_updated_at
       BEFORE UPDATE ON families
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,

    // ── Certificates ────────────────────────────────────────────────────────
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

    // ── Notifications: opt-in prefs + audit log + delayed schedule ─────────
    // Recipients are addressed by email (always) and phone (SMS opt-in).
    // We don't FK to users — many recipients are non-users (event attendees
    // who registered as guests). The log doubles as the dedupe key for the
    // reminder worker so a restart doesn't re-fire a T-1 day reminder.
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS phone              VARCHAR(40)`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS sms_opt_in         BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS reminders_opt_in   BOOLEAN DEFAULT TRUE`,

    `CREATE TABLE IF NOT EXISTS notification_log (
       id             BIGSERIAL    PRIMARY KEY,
       kind           VARCHAR(60)  NOT NULL,
       channel        VARCHAR(20)  NOT NULL,
       recipient      VARCHAR(255) NOT NULL,
       subject        TEXT,
       dedupe_key     VARCHAR(200),
       status         VARCHAR(20)  NOT NULL DEFAULT 'sent',
       provider       VARCHAR(40),
       provider_id    TEXT,
       error          TEXT,
       metadata       JSONB,
       sent_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_notif_log_kind_sent ON notification_log(kind, sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_log_recipient ON notification_log(LOWER(recipient), sent_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_log_dedupe
       ON notification_log(dedupe_key)
       WHERE dedupe_key IS NOT NULL`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_log_channel_check') THEN
         ALTER TABLE notification_log ADD CONSTRAINT notification_log_channel_check CHECK (
           channel IN ('email','sms')
         );
       END IF;
     END $$`,

    // notification_schedule — queued sends that fire at run_at. The scheduler
    // worker (services/notifications.js) polls every 60s and dispatches due
    // rows. Each row's dedupe_key is mirrored into notification_log on send.
    `CREATE TABLE IF NOT EXISTS notification_schedule (
       id           BIGSERIAL    PRIMARY KEY,
       kind         VARCHAR(60)  NOT NULL,
       channel      VARCHAR(20)  NOT NULL,
       recipient    VARCHAR(255) NOT NULL,
       payload      JSONB        NOT NULL,
       dedupe_key   VARCHAR(200),
       run_at       TIMESTAMPTZ  NOT NULL,
       dispatched_at TIMESTAMPTZ,
       attempts     INT          NOT NULL DEFAULT 0,
       last_error   TEXT,
       created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_notif_sched_due
       ON notification_schedule(run_at)
       WHERE dispatched_at IS NULL`,

    // ── Gospeler ID — per-user digital Christian identity ─────────────────────
    // One active row per email. When important fields change (church, branch,
    // legal name, role) the route handler archives the current row into
    // gospeler_id_history with version+1 and writes a new gospeler_code so the
    // QR/scan history of the previous identity stays intact and auditable.
    `CREATE TABLE IF NOT EXISTS gospeler_ids (
       id              TEXT         PRIMARY KEY,
       email           VARCHAR(255) NOT NULL UNIQUE,
       gospeler_code   VARCHAR(60)  NOT NULL UNIQUE,
       version         INT          NOT NULL DEFAULT 1,
       full_name       VARCHAR(160) NOT NULL,
       phone           VARCHAR(40),
       church_name     VARCHAR(200),
       church_branch   VARCHAR(200),
       country         VARCHAR(80),
       state_province  VARCHAR(80),
       gender          VARCHAR(20),
       date_of_birth   DATE,
       photo_base64    TEXT,
       membership_role VARCHAR(40)  DEFAULT 'member',
       verified        BOOLEAN      DEFAULT FALSE,
       issued_at       TIMESTAMPTZ  DEFAULT NOW(),
       updated_at      TIMESTAMPTZ  DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_gospeler_ids_code ON gospeler_ids(gospeler_code)`,

    // Retired Gospeler IDs. `snapshot` is the full row at the time of
    // retirement so an admin can reconstruct the historical card exactly even
    // if photo/name/role changed later.
    `CREATE TABLE IF NOT EXISTS gospeler_id_history (
       id              BIGSERIAL    PRIMARY KEY,
       email           VARCHAR(255) NOT NULL,
       gospeler_code   VARCHAR(60)  NOT NULL,
       version         INT          NOT NULL,
       snapshot        JSONB        NOT NULL,
       reason          VARCHAR(120),
       retired_at      TIMESTAMPTZ  DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_gospeler_history_email
       ON gospeler_id_history(email, version DESC)`,

    // QR-scan / verification audit. Anyone can POST a verify call (church
    // attendance scanner, event check-in) and we log the result + context so
    // the user (and church admin) can later see where their ID has been used.
    `CREATE TABLE IF NOT EXISTS gospeler_verification_logs (
       id              BIGSERIAL    PRIMARY KEY,
       gospeler_code   VARCHAR(60)  NOT NULL,
       scanned_by      VARCHAR(255),
       scan_context    VARCHAR(40),
       result          VARCHAR(20)  NOT NULL,
       metadata        JSONB,
       scanned_at      TIMESTAMPTZ  DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_gospeler_verify_code
       ON gospeler_verification_logs(gospeler_code, scanned_at DESC)`,

    // ── Gospeler ID — extended membership fields ────────────────────────────
    // Mirrors the registration webapp's attendee profile so the same person
    // identifies the same way across mobile + web. Adopted from the GOFAMINT
    // records taxonomy — `church_status` is the 28-code STATUSES enum, with
    // (region, district, assembly) replacing the looser (church_name, church_branch)
    // pair for users registered through the denomination's hierarchy. The
    // older columns remain so legacy rows aren't disturbed.
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS title          VARCHAR(40)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS church_status  VARCHAR(20)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS age_bracket    VARCHAR(40)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS city           VARCHAR(120)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS region         VARCHAR(120)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS district       VARCHAR(120)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS assembly       VARCHAR(200)`,
    // Emergency contact — same shape (name + phone) as the registration
    // webapp collects at event check-in. Storing it on the Gospeler ID lets
    // the registration auto-fill kick in here too, so members don't retype
    // their emergency contact for every event they register for.
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS emergency_contact_name  VARCHAR(120)`,
    `ALTER TABLE gospeler_ids ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(40)`,

    // ── Events / registration / tickets ────────────────────────────────────
    // Authoritative store for the gospelar registration webapp. The frontend
    // previously persisted to localStorage; now it pushes through these tables
    // via routes/events.js so tickets, capacity, and check-in state survive
    // across devices and sessions.
    //
    // event id is a TEXT slug (`retreat-2026-spring`, `youth-camp-q3`), set by
    // the admin form. Same approach the localStorage store used, so existing
    // mockData seeds line up if a dev wants to import them.
    `CREATE TABLE IF NOT EXISTS events (
       id                     TEXT         PRIMARY KEY,
       church_id              TEXT,
       title                  TEXT         NOT NULL,
       tagline                TEXT,
       summary                TEXT,
       starts_at              TIMESTAMPTZ,
       ends_at                TIMESTAMPTZ,
       registration_deadline  TIMESTAMPTZ,
       location               TEXT,
       cover_color            TEXT,
       banner_url             TEXT,
       schedule               JSONB,
       status                 TEXT         NOT NULL DEFAULT 'published',
       created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
       updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_events_status_starts ON events(status, starts_at DESC)`,

    // One row per ticket tier inside an event. (event_id, type_id) is the PK
    // so the admin form's "Standard", "Student", "Staff" stay stable across
    // edits — handlers UPSERT on the pair, never blowing away ticket history.
    `CREATE TABLE IF NOT EXISTS event_ticket_types (
       event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
       type_id      TEXT NOT NULL,
       name         TEXT NOT NULL,
       description  TEXT,
       price_cents  INT  NOT NULL DEFAULT 0,
       capacity     INT  NOT NULL DEFAULT 0,
       sold         INT  NOT NULL DEFAULT 0,
       role         TEXT NOT NULL DEFAULT 'attendee',
       sort_order   INT  NOT NULL DEFAULT 0,
       PRIMARY KEY (event_id, type_id)
     )`,

    // Same shape as ticket types — separate table because accommodation has
    // sharing/bed-count semantics ticket tiers don't.
    `CREATE TABLE IF NOT EXISTS event_accommodation (
       event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
       acc_id        TEXT NOT NULL,
       name          TEXT NOT NULL,
       description   TEXT,
       type          TEXT,
       sharing       TEXT,
       beds_per_room INT,
       price_cents   INT  NOT NULL DEFAULT 0,
       capacity      INT  NOT NULL DEFAULT 0,
       taken         INT  NOT NULL DEFAULT 0,
       sort_order    INT  NOT NULL DEFAULT 0,
       PRIMARY KEY (event_id, acc_id)
     )`,

    // Issued tickets. `code` is the human-shareable identifier (`TKT-A23B7`)
    // and the FK target for check-in/email/SMS endpoints. attendee_profile
    // captures the full registration form (title, sex, region, district…) as
    // JSON so the schema stays flat without losing per-attendee context.
    `CREATE TABLE IF NOT EXISTS event_tickets (
       code               TEXT         PRIMARY KEY,
       event_id           TEXT         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
       ticket_type_id     TEXT,
       accommodation_id   TEXT,
       group_id           TEXT,
       group_type         TEXT,
       group_name         TEXT,
       group_lead_email   TEXT,
       attendee_name      TEXT         NOT NULL,
       attendee_email     TEXT,
       attendee_phone     TEXT,
       attendee_profile   JSONB,
       age_group          TEXT,
       dietary            TEXT,
       emergency_name     TEXT,
       emergency_phone    TEXT,
       room_label         TEXT,
       seat_label         TEXT,
       role               TEXT         NOT NULL DEFAULT 'attendee',
       referrer           TEXT,
       status             TEXT         NOT NULL DEFAULT 'confirmed',
       ticket_url         TEXT,
       purchased_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
       checked_in_at      TIMESTAMPTZ,
       updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_event_tickets_event ON event_tickets(event_id, purchased_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_event_tickets_email ON event_tickets(LOWER(attendee_email)) WHERE attendee_email IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_event_tickets_group ON event_tickets(group_id) WHERE group_id IS NOT NULL`,
  ];

  for (const sql of steps) {
    try {
      await db.query(sql);
    } catch (err) {
      if (!(err.message || '').includes('already exists')) {
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

module.exports = { initDb };
