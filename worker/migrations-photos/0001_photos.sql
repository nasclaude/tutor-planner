-- Photos on lessons, in their own free D1 database (binding PHOTOS), so the main one stays small.
-- D1 hands binary columns back as plain number arrays, which is slow for large values, so each image
-- is stored as base64 text, split into rows of at most 90,000 characters.
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,      -- stored size of the photo and its preview (base64 characters)
  created_at INTEGER NOT NULL
);
CREATE INDEX photos_by_lesson ON photos (user_id, lesson_id);

CREATE TABLE photo_chunks (
  photo_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'full' or 'thumb' (the small preview)
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (photo_id, kind, idx)
);
