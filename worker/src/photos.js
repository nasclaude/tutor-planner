// Photos on lessons (the whiteboard, a worksheet, homework). They live in their own free D1 database
// (binding PHOTOS), stored as base64 text split into small rows (see migrations-photos/0001_photos.sql).
// The app shrinks every photo before uploading it and also sends a small preview.
import { HttpError, json } from './util.js';
import { getRow } from './crud.js';

export const CHUNK = 90_000; // characters per stored row: safely under D1's 100 KB statement limit
export const MAX_PHOTO_CHARS = 1_400_000; // about 1 MB of image; the app sends 150–350 KB
export const MAX_THUMB_CHARS = 200_000;
export const MAX_PER_LESSON = 30;
// Stop taking new photos before the free 500 MB database is full (PHOTO_STORAGE_LIMIT overrides it).
const STORAGE_LIMIT = 450_000_000;
const ID_BATCH = 90; // D1 allows at most 100 bound values per query

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function photosDb(env) {
  if (!env.PHOTOS) throw new HttpError(500, 'Photos are not set up on the server', 'photos_not_configured');
  return env.PHOTOS;
}

// The image format, from the first bytes of the base64 text.
export function imageType(b64) {
  let head;
  try {
    head = atob(b64.slice(0, 16));
  } catch {
    return null;
  }
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff) return 'image/jpeg';
  if (head.charCodeAt(0) === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
  if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function checkImage(value, max) {
  if (typeof value === 'string' && value.length > max) throw new HttpError(413, 'This photo is too large', 'photo_too_big');
  const type = typeof value === 'string' && value.length % 4 === 0 && BASE64.test(value) ? imageType(value) : null;
  if (!type) throw new HttpError(400, 'That file could not be read as a photo', 'bad_photo');
  return type;
}

const pieces = (text) => {
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out;
};

async function ownLesson(env, lessonId, userId) {
  if (!(await getRow(env, 'lessons', lessonId, userId))) throw new HttpError(404, 'Lesson not found', 'not_found');
}

export async function listPhotos(env, user, lessonId) {
  await ownLesson(env, lessonId, user.id);
  const { results } = await photosDb(env)
    .prepare('SELECT id, width, height, created_at FROM photos WHERE user_id = ? AND lesson_id = ? ORDER BY created_at, id')
    .bind(user.id, lessonId)
    .all();
  return json({ photos: results });
}

export async function addPhoto(env, user, lessonId, body) {
  await ownLesson(env, lessonId, user.id);
  const { photo, thumb } = body;
  const type = checkImage(photo, MAX_PHOTO_CHARS);
  checkImage(thumb, MAX_THUMB_CHARS);
  const width = Number(body.width);
  const height = Number(body.height);
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 10_000)) {
    throw new HttpError(400, 'That file could not be read as a photo', 'bad_photo');
  }

  const db = photosDb(env);
  const [count, used] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ? AND lesson_id = ?').bind(user.id, lessonId),
    db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM photos'),
  ]);
  if (count.results[0].n >= MAX_PER_LESSON) {
    throw new HttpError(409, `A lesson can have up to ${MAX_PER_LESSON} photos`, 'too_many_photos');
  }
  const bytes = photo.length + thumb.length;
  if (used.results[0].n + bytes > (Number(env.PHOTO_STORAGE_LIMIT) || STORAGE_LIMIT)) {
    throw new HttpError(507, 'The photo storage is full', 'photos_full');
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const insert = db.prepare('INSERT INTO photo_chunks (photo_id, kind, idx, data) VALUES (?, ?, ?, ?)');
  // One batch is one transaction: the photo is saved completely or not at all.
  await db.batch([
    db
      .prepare('INSERT INTO photos (id, user_id, lesson_id, content_type, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, user.id, lessonId, type, width, height, bytes, now),
    ...pieces(photo).map((data, i) => insert.bind(id, 'full', i, data)),
    ...pieces(thumb).map((data, i) => insert.bind(id, 'thumb', i, data)),
  ]);
  return json({ id, width, height, created_at: now }, 201);
}

// One photo ("full") or its preview ("thumb"): { type, data } with data as base64.
export async function getPhoto(env, user, photoId, kind) {
  const { results } = await photosDb(env)
    .prepare(
      `SELECT c.data FROM photo_chunks c JOIN photos p ON p.id = c.photo_id
        WHERE p.id = ? AND p.user_id = ? AND c.kind = ? ORDER BY c.idx`,
    )
    .bind(photoId, user.id, kind)
    .all();
  if (!results.length) throw new HttpError(404, 'Photo not found', 'photo_not_found');
  const data = results.map((r) => r.data).join('');
  // Not cached by the browser: on a shared phone, the next person's requests must be checked again.
  return json({ type: imageType(data) ?? 'image/jpeg', data }, 200, { 'Cache-Control': 'no-store' });
}

export async function deletePhoto(env, user, photoId) {
  const db = photosDb(env);
  const row = await db.prepare('SELECT lesson_id FROM photos WHERE id = ? AND user_id = ?').bind(photoId, user.id).first();
  if (!row) throw new HttpError(404, 'Photo not found', 'photo_not_found');
  await db.batch([
    db.prepare('DELETE FROM photo_chunks WHERE photo_id = ?').bind(photoId),
    db.prepare('DELETE FROM photos WHERE id = ?').bind(photoId),
  ]);
  return json({ ok: true, lesson_id: row.lesson_id });
}

// How many photos each lesson has, for the camera mark in lesson lists.
export async function photoCounts(env, userId) {
  if (!env.PHOTOS) return {};
  try {
    const { results } = await env.PHOTOS.prepare('SELECT lesson_id, COUNT(*) AS n FROM photos WHERE user_id = ? GROUP BY lesson_id')
      .bind(userId)
      .all();
    return Object.fromEntries(results.map((r) => [r.lesson_id, r.n]));
  } catch (err) {
    console.error('photo counts', err);
    return {};
  }
}

// When lessons are deleted (one, "this and following", or all of a student's), their photos go too.
export async function deleteLessonPhotos(env, userId, lessonIds) {
  if (!env.PHOTOS || !lessonIds.length) return;
  const db = env.PHOTOS;
  for (let i = 0; i < lessonIds.length; i += ID_BATCH) {
    const ids = lessonIds.slice(i, i + ID_BATCH);
    const marks = ids.map(() => '?').join(', ');
    await db.batch([
      db
        .prepare(`DELETE FROM photo_chunks WHERE photo_id IN (SELECT id FROM photos WHERE user_id = ? AND lesson_id IN (${marks}))`)
        .bind(userId, ...ids),
      db.prepare(`DELETE FROM photos WHERE user_id = ? AND lesson_id IN (${marks})`).bind(userId, ...ids),
    ]);
  }
}

export async function deleteUserPhotos(env, userId) {
  if (!env.PHOTOS) return;
  const db = env.PHOTOS;
  await db.batch([
    db.prepare('DELETE FROM photo_chunks WHERE photo_id IN (SELECT id FROM photos WHERE user_id = ?)').bind(userId),
    db.prepare('DELETE FROM photos WHERE user_id = ?').bind(userId),
  ]);
}

// Safety net, once a day: removes photos whose lesson no longer exists (if deleting them right away
// failed, since the two databases can't be changed in one transaction). Kept small, because the free
// plan allows 50 database queries per run: up to 900 random lessons are checked and 5 cleaned per day.
export async function cleanupOrphanPhotos(env) {
  if (!env.PHOTOS) return 0;
  const { results } = await env.PHOTOS.prepare('SELECT DISTINCT user_id, lesson_id FROM photos ORDER BY random() LIMIT 900').all();
  const orphans = [];
  for (let i = 0; i < results.length && orphans.length < 5; i += ID_BATCH) {
    const batch = results.slice(i, i + ID_BATCH);
    const { results: found } = await env.DB.prepare(`SELECT id FROM lessons WHERE id IN (${batch.map(() => '?').join(', ')})`)
      .bind(...batch.map((r) => r.lesson_id))
      .all();
    const alive = new Set(found.map((r) => r.id));
    orphans.push(...batch.filter((r) => !alive.has(r.lesson_id)));
  }
  for (const r of orphans.slice(0, 5)) await deleteLessonPhotos(env, r.user_id, [r.lesson_id]);
  return Math.min(orphans.length, 5);
}
