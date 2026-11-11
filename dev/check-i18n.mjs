// Checks the app's texts: every key the code uses exists in English and Bulgarian, and both
// dictionaries have the same keys.   node dev/check-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'web/js/i18n.js'), 'utf8');
const block = (name) => {
  const start = source.indexOf(`const ${name} = {`);
  return source.slice(start, source.indexOf('\n};', start));
};
const keysOf = (text) => new Set([...text.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const en = keysOf(block('en'));
const bg = keysOf(block('bg'));

const files = [path.join(root, 'web/index.html')];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.js') && name !== 'i18n.js') files.push(full);
  }
};
walk(path.join(root, 'web/js'));

const used = new Map(); // key -> files
const use = (key, file) => used.set(key, new Set([...(used.get(key) ?? []), path.relative(root, file)]));
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\b(?:t|th)\(\s*'([\w.]+)'/g)) use(m[1], file);
  for (const m of text.matchAll(/\btn\(\s*'([\w.]+)'/g)) ['one', 'other'].forEach((p) => use(`${m[1]}.${p}`, file));
  for (const m of text.matchAll(/data-i18n="([\w.]+)"/g)) use(m[1], file);
}

const missing = [...used].filter(([key]) => !en.has(key) || !bg.has(key)).map(([key, where]) => `${key} (${[...where].join(', ')})`);
const onlyEn = [...en].filter((k) => !bg.has(k));
const onlyBg = [...bg].filter((k) => !en.has(k));
console.log(`keys used: ${used.size} | en: ${en.size} | bg: ${bg.size}`);
console.log('used but missing:', missing.length ? missing : 'none');
console.log('only in English:', onlyEn.length ? onlyEn : 'none');
console.log('only in Bulgarian:', onlyBg.length ? onlyBg : 'none');
process.exitCode = missing.length || onlyEn.length || onlyBg.length ? 1 : 0;
