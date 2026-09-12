// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 로컬 상태 파일 입출력: JSON·줄 단위 텍스트·원시 바이트를 임시파일+rename으로 안전하게 쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// 윈도에서는 방금 만든 임시 파일을 백신·색인기가 잠깐 쥐고 있어 rename 이 EPERM/EBUSY 로 튕기는 일이 있다.
// 바로 포기하면 그 순간의 gapFill·보내기가 통째로 실패하므로, 짧게 몇 번 다시 해 본다.
const RENAME_TRIES = 5;
async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, data);
  for (let i = 1; ; i += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (i >= RENAME_TRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        await fs.rm(tmp, { force: true }).catch(() => {}); // 실패했으면 임시 파일을 남기지 않는다
        throw e;
      }
      await new Promise((r) => setTimeout(r, 20 * i));
    }
  }
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
