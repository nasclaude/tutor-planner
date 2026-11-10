-- The morning summary goes out at most once per person per day; this records the days already sent.
CREATE TABLE summary_log (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- the person's local date, YYYY-MM-DD
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
