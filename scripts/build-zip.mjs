// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 서명 zip 빌드(설계 조각 8·Task 12): module/(test·lib·state 제외) + hub/client/*.mjs(test 제외) → lib/ 로 dist/stage/ 에 모으고
// import 경로를 치환한 뒤 매니페스트(+선택 서명)를 붙여 zip으로 묶는다. Face 콘센트 계약 = P02 docs/모듈-계약-v1.md.
//   node scripts/build-zip.mjs [--key <pem>] [--out <zip>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipWrite } from './lib/zip.mjs';
import { buildManifest, signManifest } from './lib/modsign.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const KEY_PATH = arg('key', null);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const OUT = path.resolve(ROOT, arg('out', path.join('dist', `iris-messenger-v${VERSION}.zip`)));
const STAGE = path.join(ROOT, 'dist', 'stage');
const MODULE_DIR = path.join(ROOT, 'module');
const HUB_CLIENT_DIR = path.join(ROOT, 'hub', 'client');

const moduleInfo = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'module.json'), 'utf8'));
if (moduleInfo.version !== VERSION) {
  console.error(`module.json version (${moduleInfo.version}) !== package.json version (${VERSION})`);
  process.exit(2);
}

// ① dist/stage/ 를 비우고 module/(test·lib·state 제외)을 복사한다.
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
const SKIP_TOP = new Set(['test', 'lib', 'state']);
fs.cpSync(MODULE_DIR, STAGE, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(MODULE_DIR, src);
    if (!rel) return true;
    return !SKIP_TOP.has(rel.split(path.sep)[0]);
  },
});

// ② hub/client/*.mjs(test 제외) → dist/stage/lib/
const LIB_DIR = path.join(STAGE, 'lib');
fs.mkdirSync(LIB_DIR, { recursive: true });
for (const name of fs.readdirSync(HUB_CLIENT_DIR)) {
  const full = path.join(HUB_CLIENT_DIR, name);
  if (fs.statSync(full).isDirectory()) continue; // test/ 제외
  if (!name.endsWith('.mjs')) continue; // *.mjs 만(AGENTS.md 등 제외)
  fs.copyFileSync(full, path.join(LIB_DIR, name));
}

// ③ 복사된 module/*.mjs 안의 '../hub/client/ 를 ./lib/ 로 치환한다.
for (const name of fs.readdirSync(STAGE)) {
  const full = path.join(STAGE, name);
  if (!name.endsWith('.mjs') || fs.statSync(full).isDirectory()) continue;
  const before = fs.readFileSync(full, 'utf8');
  const after = before.replace(/'\.\.\/hub\/client\//g, "'./lib/").replace(/"\.\.\/hub\/client\//g, '"./lib/');
  if (after !== before) fs.writeFileSync(full, after, 'utf8');
}

// ④ 스테이지 전체를 모아 매니페스트·zip 항목을 만든다.
function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push({ name: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
  }
  return out;
}
const files = walk(STAGE, STAGE);

const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const manifest = buildManifest(files, { source });
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

const entries = files.map((f) => ({ name: f.name, data: f.data, deflate: true }));
entries.push({ name: 'manifest.json', data: Buffer.from(manifestText, 'utf8'), deflate: true });
fs.writeFileSync(path.join(STAGE, 'manifest.json'), manifestText, 'utf8');

let signed = false;
if (KEY_PATH) {
  const privatePem = fs.readFileSync(KEY_PATH, 'utf8');
  const sig = signManifest(manifestText, privatePem);
  entries.push({ name: 'manifest.sig', data: Buffer.from(sig, 'utf8'), deflate: true });
  fs.writeFileSync(path.join(STAGE, 'manifest.sig'), sig, 'utf8');
  signed = true;
}

// ⑤ zip 으로 묶어 --out 에 쓴다.
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zipWrite(entries));

const outDisplay = path.relative(process.cwd(), OUT).split(path.sep).join('/');
console.log(`${outDisplay} files=${entries.length} signed=${signed} source=${source}`);
