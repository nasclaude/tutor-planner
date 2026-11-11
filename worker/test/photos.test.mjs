import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, client } from './helpers.mjs';
import { CHUNK, MAX_PHOTO_CHARS, MAX_PER_LESSON, cleanupOrphanPhotos } from '../src/photos.js';
import worker from '../src/index.js';

const DAY = 86_400_000;
// A JPEG-looking image of about `bytes` bytes, as base64.
const jpeg = (bytes = 300) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(bytes)]).toString('base64');
const photoBody = (size = 300) => ({ photo: jpeg(size), thumb: jpeg(60), width: 1600, height: 1200 });

async function setup(overrides) {
  const env = await makeEnv(overrides);
  const api = client(env);
  await api.login();
  const student = (await api.post('/api/students', { name: 'Arthas Menethil' })).body;
  const lesson = (await api.post('/api/lessons', { student_id: student.id, start_at: Date.now() + DAY })).body;
  return { env, api, student, lesson };
}

const chunkRows = (env, id) => env.PHOTOS.raw.prepare('SELECT kind, idx, length(data) AS len FROM photo_chunks WHERE photo_id = ? ORDER BY kind, idx').all(id);

test('a photo is saved, listed and read back exactly, with its preview', async () => {
  const { env, api, lesson } = await setup();
  const body = photoBody();
  const added = await api.post(`/api/lessons/${lesson.id}/photos`, body);
  assert.equal(added.status, 201);
  assert.equal(added.body.width, 1600);

  const list = await api.get(`/api/lessons/${lesson.id}/photos`);
  assert.deepEqual(list.body.photos.map((p) => p.id), [added.body.id]);

  const full = await api.get(`/api/photos/${added.body.id}`);
  assert.deepEqual(full.body, { type: 'image/jpeg', data: body.photo });
  assert.equal(full.headers.get('Cache-Control'), 'no-store');
  const thumb = await api.get(`/api/photos/${added.body.id}?size=thumb`);
  assert.equal(thumb.body.data, body.thumb);

  assert.deepEqual((await api.get('/api/data')).body.photoCounts, { [lesson.id]: 1 });
});

test('a large photo is stored in pieces small enough for Cloudflare and comes back whole', async () => {
  const { env, api, lesson } = await setup();
  const photo = jpeg(Math.floor((MAX_PHOTO_CHARS / 4) * 3) - 10); // just under the limit
  const added = await api.post(`/api/lessons/${lesson.id}/photos`, { ...photoBody(), photo });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const rows = chunkRows(env, added.body.id).filter((r) => r.kind === 'full');
  assert.equal(rows.length, Math.ceil(photo.length / CHUNK));
  assert.ok(rows.every((r) => r.len <= CHUNK));
  assert.equal((await api.get(`/api/photos/${added.body.id}`)).body.data, photo);
});

test('refuses files that are not photos, or too big', async () => {
  const { api, lesson } = await setup();
  const url = `/api/lessons/${lesson.id}/photos`;
  const cases = [
    [{ ...photoBody(), photo: 'not a photo!' }, 400, 'bad_photo'],
    [{ ...photoBody(), photo: Buffer.from('just some text, not an image').toString('base64') }, 400, 'bad_photo'],
    [{ ...photoBody(), thumb: undefined }, 400, 'bad_photo'],
    [{ ...photoBody(), width: 0 }, 400, 'bad_photo'],
    [{ ...photoBody(), photo: 'A'.repeat(MAX_PHOTO_CHARS + 4) }, 413, 'photo_too_big'],
  ];
  for (const [body, status, code] of cases) {
    const res = await api.post(url, body);
    assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual((await api.get(url)).body.photos, []);
});

test("nobody else can see, add to or delete someone's photos", async () => {
  const { env, api, lesson } = await setup();
  const id = (await api.post(`/api/lessons/${lesson.id}/photos`, photoBody())).body.id;
  const maria = client(env);
  await maria.login('maria', 'maria-pass-1');
  assert.equal((await maria.get(`/api/lessons/${lesson.id}/photos`)).status, 404);
  assert.equal((await maria.post(`/api/lessons/${lesson.id}/photos`, photoBody())).status, 404);
  assert.equal((await maria.get(`/api/photos/${id}`)).status, 404);
  assert.equal((await maria.get(`/api/photos/${id}?size=thumb`)).status, 404);
  assert.equal((await maria.call('DELETE', `/api/photos/${id}`)).status, 404);
  assert.deepEqual((await maria.get('/api/data')).body.photoCounts, {});
  assert.equal((await api.get(`/api/photos/${id}`)).status, 200, 'still there for the owner');
});

test('deleting a photo removes it completely', async () => {
  const { env, api, lesson } = await setup();
  const id = (await api.post(`/api/lessons/${lesson.id}/photos`, photoBody())).body.id;
  const res = await api.del(`/api/photos/${id}`);
  assert.deepEqual(res.body, { ok: true, lesson_id: lesson.id });
  assert.equal((await api.get(`/api/photos/${id}`)).status, 404);
  assert.equal(chunkRows(env, id).length, 0);
  assert.deepEqual((await api.get('/api/data')).body.photoCounts, {});
});

test('photos go with their lesson, series, student or account', async () => {
  const { env, api, student, lesson } = await setup();
  const add = async (lessonId) => (await api.post(`/api/lessons/${lessonId}/photos`, photoBody())).body.id;
  const count = () => env.PHOTOS.raw.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
  const chunks = () => env.PHOTOS.raw.prepare('SELECT COUNT(*) AS n FROM photo_chunks').get().n;

  await add(lesson.id);
  await api.del(`/api/lessons/${lesson.id}`);
  assert.equal(count(), 0, 'one lesson');

  const start = Date.now() + DAY;
  const { rows } = (await api.post('/api/lessons/bulk', { items: [0, 1, 2, 3].map((i) => ({ student_id: student.id, start_at: start + i * 7 * DAY })) })).body;
  await add(rows[1].id);
  await add(rows[3].id);
  await api.del(`/api/lessons/${rows[2].id}?following=1`);
  assert.deepEqual(env.PHOTOS.raw.prepare('SELECT lesson_id FROM photos').all().map((r) => r.lesson_id), [rows[1].id], '"this and following"');

  await add(rows[0].id);
  await api.del(`/api/students/${student.id}`);
  assert.equal(count(), 0, 'a student and all their lessons');
  assert.equal(chunks(), 0);

  const maria = client(env);
  await maria.login('maria', 'maria-pass-1');
  const s2 = (await maria.post('/api/students', { name: 'Jaina' })).body;
  const l2 = (await maria.post('/api/lessons', { student_id: s2.id, start_at: start })).body;
  await maria.post(`/api/lessons/${l2.id}/photos`, photoBody());
  const mariaId = (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind('maria').first()).id;
  assert.equal((await api.del(`/api/admin/users/${mariaId}`)).status, 200);
  assert.equal(count(), 0, 'a removed account');
  assert.equal(chunks(), 0);
});

test('limits: photos per lesson, and space left in the free database', async () => {
  const { api, lesson } = await setup();
  for (let i = 0; i < MAX_PER_LESSON; i++) assert.equal((await api.post(`/api/lessons/${lesson.id}/photos`, photoBody(30))).status, 201);
  const extra = await api.post(`/api/lessons/${lesson.id}/photos`, photoBody(30));
  assert.deepEqual([extra.status, extra.body.code], [409, 'too_many_photos']);

  const small = await setup({ PHOTO_STORAGE_LIMIT: '900' }); // each test photo takes 496 characters
  const url = `/api/lessons/${small.lesson.id}/photos`;
  assert.equal((await small.api.post(url, photoBody(300))).status, 201);
  const full = await small.api.post(url, photoBody(300));
  assert.deepEqual([full.status, full.body.code], [507, 'photos_full']);
});

test('the daily clean-up removes photos whose lesson is gone', async () => {
  const { env, api, lesson } = await setup();
  const keep = (await api.post('/api/lessons', { student_id: lesson.student_id, start_at: Date.now() + 2 * DAY })).body;
  await api.post(`/api/lessons/${lesson.id}/photos`, photoBody());
  await api.post(`/api/lessons/${keep.id}/photos`, photoBody());
  await env.DB.prepare('DELETE FROM lessons WHERE id = ?').bind(lesson.id).run(); // as if the photo clean-up had failed
  assert.equal(await cleanupOrphanPhotos(env), 1);
  assert.deepEqual(env.PHOTOS.raw.prepare('SELECT lesson_id FROM photos').all().map((r) => r.lesson_id), [keep.id]);
});

test('without the photo database the rest of the app still works', async () => {
  const { env, api, lesson } = await setup();
  delete env.PHOTOS;
  const data = await api.get('/api/data');
  assert.equal(data.status, 200);
  assert.deepEqual(data.body.photoCounts, {});
  const res = await api.post(`/api/lessons/${lesson.id}/photos`, photoBody());
  assert.deepEqual([res.status, res.body.code], [500, 'photos_not_configured']);
  assert.equal((await api.del(`/api/lessons/${lesson.id}`)).status, 200);
  assert.ok(worker.fetch);
});
