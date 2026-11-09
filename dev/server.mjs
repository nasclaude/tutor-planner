// Local preview of the whole app, no Cloudflare needed:
//   node dev/server.mjs              app on http://localhost:8080, API on :8787
//                                    (first time: create the owner account with the setup code "dev")
//   node dev/server.mjs --seed       on an empty database: a demo owner (owner / demo1234) with demo data
//   node dev/server.mjs --port 9080  another port (the API is always on the app's port + 707)
//   node dev/server.mjs --memory     keep data in memory only (for automated tests)
// Without --memory, data is kept in dev/dev.db and survives restarts.
// Reminders are checked every minute, like on Cloudflare.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { createD1, applyMigrations } from './d1-shim.mjs';
import worker from '../worker/src/index.js';
import { createToken, createUser } from '../worker/src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const APP_PORT = Number(option('--port', 8080));
const API_PORT = APP_PORT + 707; // web/config.js uses the same rule

function devVapidKey() {
  const file = path.join(ROOT, 'dev', '.vapid.json');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { d, x, y } = privateKey.export({ format: 'jwk' });
  const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', d, x, y });
  writeFileSync(file, jwk);
  return jwk;
}

const DB = createD1(args.includes('--memory') ? ':memory:' : path.join(ROOT, 'dev', 'dev.db'));
await applyMigrations(DB, path.join(ROOT, 'worker', 'migrations'));

const env = {
  DB,
  SETUP_CODE: process.env.SETUP_CODE || 'dev',
  PASSWORD_PEPPER: 'local-dev-pepper',
  SESSION_SECRET: 'local-dev-session-secret',
  VAPID_PRIVATE_JWK: devVapidKey(),
  VAPID_SUBJECT: 'https://localhost/',
  ALLOWED_ORIGINS: `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`,
};
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((err) => console.error(err)), passThroughOnException() {} };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Static files (what GitHub Pages will serve).
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${APP_PORT}`);
    let file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
    if (!file.startsWith(WEB)) return res.writeHead(403).end();
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  })
  .listen(APP_PORT, () => console.log(`App  http://localhost:${APP_PORT}   (setup code for the first account: ${env.SETUP_CODE})`));

// The API (what Cloudflare will run).
http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!['host', 'connection', 'content-length'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method) && chunks.length > 0;
    const request = new Request(`http://localhost:${API_PORT}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(API_PORT, () => console.log(`API  http://localhost:${API_PORT}   (data: ${args.includes('--memory') ? 'in memory' : 'dev/dev.db'})`));

// Same schedule as the Cloudflare cron trigger: every minute, on the minute.
function scheduleReminders() {
  setTimeout(async () => {
    const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;
    await worker.scheduled({ scheduledTime, cron: '* * * * *' }, env, ctx);
    scheduleReminders();
  }, 60_000 - (Date.now() % 60_000) + 50);
}
scheduleReminders();

if (args.includes('--seed')) await seed();

async function seed() {
  const used = (await DB.prepare('SELECT COUNT(*) AS n FROM users').first('n')) + (await DB.prepare('SELECT COUNT(*) AS n FROM students').first('n'));
  if (used) {
    console.log('Seed skipped: the database is not empty.');
    return;
  }
  const owner = await createUser(env, { name: 'Demo Owner', username: 'owner', password: 'demo1234', isAdmin: true });
  const token = await createToken(env, owner);
  const post = async (table, body) => {
    const res = await worker.fetch(
      new Request(`http://localhost/api/${table}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
    return res.json();
  };
  const at = (days, hh, mm = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  };
  const day = (days) => {
    const d = new Date(at(days, 12));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const arthas = await post('students', {
    name: 'Arthas Menethil', subject: 'Math', grade_level: '8th grade', school: 'Lordaeron High',
    parent_name: 'Terenas Menethil', parent_phone: '+359 88 123 4567', price: 25,
    notes: 'Strong at algebra, rushes word problems. Exam on 15 March.',
  });
  const jaina = await post('students', { name: 'Jaina Proudmoore', subject: 'English', grade_level: '10th grade', phone: '+359 87 765 4321', price: 30 });
  const thrall = await post('students', { name: 'Thrall Durotan', subject: 'Physics', grade_level: '11th grade', price: 30 });
  const sylvanas = await post('students', { name: 'Sylvanas Windrunner', subject: 'Math', grade_level: '9th grade', price: 25 });

  const past = await post('lessons', { student_id: arthas.id, start_at: at(-3, 17), topic: 'Linear equations', price: 25, status: 'completed', notes: 'Did 2-step equations. Needs practice with negatives.' });
  await post('lessons', { student_id: arthas.id, start_at: at(-10, 17), topic: 'Fractions', price: 25, status: 'completed', paid: true });
  await post('lessons', { student_id: arthas.id, start_at: at(1, 13), topic: 'Word problems', price: 25 });
  await post('lessons', { student_id: arthas.id, start_at: at(0, 19), topic: 'Revision', price: 25 });
  await post('lessons', { student_id: jaina.id, start_at: at(0, 10), topic: 'Essay structure', price: 30, status: 'completed', paid: true });
  await post('lessons', { student_id: jaina.id, start_at: at(-2, 18), price: 30, status: 'completed' });
  await post('lessons', { student_id: jaina.id, start_at: at(2, 18), topic: 'Reading comprehension', price: 30, remind_offsets: [1440, 60] });
  await post('lessons', { student_id: thrall.id, start_at: at(-1, 16), topic: 'Newton’s laws', price: 30 });
  await post('lessons', { student_id: thrall.id, start_at: at(1, 13, 30), duration_min: 90, topic: 'Forces', price: 30 });
  await post('lessons', { student_id: sylvanas.id, start_at: at(3, 11), price: 25, reminders_on: false });
  await post('lessons', { student_id: sylvanas.id, start_at: at(-5, 12), price: 25, status: 'cancelled' });

  await post('grades', { student_id: arthas.id, date: day(-12), value: '5', title: 'School test: fractions' });
  await post('grades', { student_id: arthas.id, date: day(-4), value: '6', title: 'Homework check' });
  await post('grades', { student_id: jaina.id, date: day(-6), value: 'A', title: 'Essay' });
  await post('homework', { student_id: arthas.id, lesson_id: past.id, text: 'Exercises 1–10, page 45' });
  await post('homework', { student_id: arthas.id, text: 'Read chapter 4', status: 'done' });

  await post('events', { title: 'Call the bank', note: 'Ask about the card limit.\nHave the contract number ready.', start_at: at(0, 15), remind_offsets: [15] });
  await post('events', { title: 'Buy printer ink', start_at: at(1, 9), remind_offsets: [0] });
  await post('events', { title: 'Parent meeting: Jaina', note: 'Bring the essay results', start_at: at(2, 17), duration_min: 30, remind_offsets: [60] });
  await post('events', { title: 'Pay rent', start_at: at(-1, 12), status: 'completed' });
  await post('events', { title: 'Dentist check-up', note: 'Moved to next month', start_at: at(0, 12), status: 'cancelled' });
  await post('events', { title: 'Print worksheets', start_at: at(0, 9), status: 'completed', remind_offsets: [0] });
  console.log('Seeded demo data for owner / demo1234: 4 students, 11 lessons, 6 reminders.');
}
