-- Tutor Planner database (Cloudflare D1 / SQLite)
-- Times are stored as epoch milliseconds (UTC). Dates without a time are 'YYYY-MM-DD'.

CREATE TABLE students (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  subject      TEXT,
  grade_level  TEXT,              -- e.g. "8th grade"
  school       TEXT,
  phone        TEXT,
  parent_name  TEXT,
  parent_phone TEXT,
  price        REAL,              -- default price per lesson
  notes        TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE lessons (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  start_at     INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  topic        TEXT,
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | completed | cancelled
  reminders_on INTEGER NOT NULL DEFAULT 1,
  remind_offsets TEXT,            -- JSON list of minutes before the start, e.g. [180,120,60]; 0 = at the start
  notes        TEXT,
  price        REAL,
  paid         INTEGER NOT NULL DEFAULT 0,
  paid_at      INTEGER,
  series_id    TEXT,              -- lessons created together as a repeating series share this id
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX lessons_by_start ON lessons(start_at);
CREATE INDEX lessons_by_student ON lessons(student_id);
CREATE INDEX lessons_by_series ON lessons(series_id);

CREATE TABLE grades (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  value      TEXT NOT NULL,       -- free text: "6", "A", "85%"
  title      TEXT,                -- e.g. "Test: fractions"
  note       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX grades_by_student ON grades(student_id);

CREATE TABLE homework (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_id  TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open', -- open | done | missed
  due_date   TEXT,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX homework_by_student ON homework(student_id);

-- Planner reminders that aren't lessons ("Call the bank", with a note).
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  note         TEXT,
  start_at     INTEGER NOT NULL,
  duration_min INTEGER,           -- optional
  reminders_on INTEGER NOT NULL DEFAULT 1,
  remind_offsets TEXT,            -- JSON list of minutes before; [0] = at the time
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | completed | cancelled (same as lessons)
  series_id    TEXT,              -- set when created as a repeating series
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX events_by_start ON events(start_at);
CREATE INDEX events_by_series ON events(series_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL             -- JSON
);

CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);

-- One row per notification already sent (for a lesson or an event). start_at is part of the
-- key so that moving an item automatically re-arms its reminders.
CREATE TABLE reminder_log (
  item_id    TEXT NOT NULL,
  start_at   INTEGER NOT NULL,
  offset_min INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (item_id, start_at, offset_min)
);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_attempts_by_ip ON login_attempts(ip, at);
