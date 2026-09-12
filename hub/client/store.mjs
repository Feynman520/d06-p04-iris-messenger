// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 로컬 상태 파일 입출력: JSON·줄 단위 텍스트·원시 바이트를 임시파일+rename으로 안전하게 쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// 원시 바이트(DPAPI 블롭 등)를 임시파일+rename으로 원자적으로 쓴다.
export async function writeFileAtomic(file, buf) {
  await writeAtomic(file, buf);
}

export async function readJson(file, def = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return def;
    throw e;
  }
}

export async function writeJson(file, obj) {
  await writeAtomic(file, JSON.stringify(obj));
}

export async function appendLine(file, str) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, str.endsWith('\n') ? str : `${str}\n`, 'utf8');
}

export async function readLines(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/).filter((l) => l.length > 0);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
