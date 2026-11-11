// A tiny stand-in for Cloudflare D1 on top of Node's built-in SQLite, used for local
// development and tests (Cloudflare's own local runtime needs a newer macOS).
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const normalize = (params) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
const plain = (row) => (row ? { ...row } : null);
const isQuery = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

// Cloudflare D1's limits, so tests catch queries the real database would refuse. Whether bound values
// count toward the 100 KB statement limit isn't documented, so they are counted here to be safe.
const MAX_STATEMENT = 100_000;
const MAX_PARAMS = 100;
function checkLimits(sql, params) {
  if (params.length > MAX_PARAMS) throw new Error(`D1 limit: ${params.length} bound parameters (max ${MAX_PARAMS})`);
  const size = sql.length + params.reduce((n, p) => n + (typeof p === 'string' ? p.length : 8), 0);
  if (size > MAX_STATEMENT) throw new Error(`D1 limit: statement of ${size} bytes (max ${MAX_STATEMENT})`);
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
    checkLimits(sql, params);
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  _first() {
    return plain(this.db.prepare(this.sql).get(...normalize(this.params)));
  }
  _all() {
    return { results: this.db.prepare(this.sql).all(...normalize(this.params)).map(plain), success: true, meta: {} };
  }
  _run() {
    const r = this.db.prepare(this.sql).run(...normalize(this.params));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(column) {
    const row = this._first();
    return column ? (row ? row[column] : null) : row;
  }
  async all() {
    return this._all();
  }
  async run() {
    return this._run();
  }
}

export function createD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => (isQuery(s.sql) ? s._all() : s._run()));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1 };
    },
    raw: db,
  };
}

export async function applyMigrations(d1, dir) {
  d1.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const done = new Set(d1.raw.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    d1.raw.exec(await readFile(path.join(dir, file), 'utf8'));
    d1.raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}
