-- Accounts: every piece of data belongs to one user, and people join by invitation.

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  username             TEXT NOT NULL UNIQUE,       -- stored in lowercase
  password_hash        TEXT NOT NULL,              -- pbkdf2$<iterations>$<salt>$<hash>, with a secret pepper
  is_admin             INTEGER NOT NULL DEFAULT 0, -- the owner: can invite people and reset passwords
  must_change_password INTEGER NOT NULL DEFAULT 0, -- after a reset by the owner
  token_version        INTEGER NOT NULL DEFAULT 0, -- raised to log the user out on every device
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  note       TEXT,               -- who it's for, as a reminder for the owner
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by    TEXT,
  used_at    INTEGER
);

-- Rows that existed before accounts get user_id '' and are taken over by the first (owner) account.
ALTER TABLE students ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE lessons ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE grades ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE homework ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE push_subscriptions ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
CREATE INDEX students_by_user ON students(user_id);
CREATE INDEX lessons_by_user ON lessons(user_id, start_at);
CREATE INDEX grades_by_user ON grades(user_id);
CREATE INDEX homework_by_user ON homework(user_id);
CREATE INDEX events_by_user ON events(user_id, start_at);
CREATE INDEX push_by_user ON push_subscriptions(user_id);

-- Settings (language, currency, reminder times...) are per user now.
CREATE TABLE user_settings (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,          -- JSON
  PRIMARY KEY (user_id, key)
);
INSERT INTO user_settings (user_id, key, value) SELECT '', key, value FROM settings;
DROP TABLE settings;

-- Failed logins are counted per username as well as per IP address.
ALTER TABLE login_attempts ADD COLUMN username TEXT;
