// IRIS-Face · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// P02 IRIS-Face daemon/zip.mjs 사본(2026-09-13). 바뀌면 P02가 정본.
// 최소 zip 읽기/쓰기(모듈 설치 전용, 외부 의존 0). 읽기: 저장(0)·deflate(8). 쓰기: 저장(0)·deflate(8). ZIP64 미지원(모듈 zip은 수 MB).
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;

// 폭탄 방어 기본 상한(설계 조각 F1) — 호출자가 zipRead(buf, opts)로 덮어쓸 수 있다.
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 10000;

function findEocd(buf) {
  // Finds the last EOCD signature; does not validate comment-length field (minimal parser limitation).
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  throw new Error('not a zip (no end-of-central-directory)');
}

/** zip 버퍼 → [{ name, data }] (폴더 항목 제외). 이름은 zip 안 표기 그대로(슬래시).
 *  opts: { maxEntryBytes, maxTotalBytes, maxEntries } — 압축해제 폭탄 방어(선언된 usize·실제 해제 결과 양쪽 다 상한 검사). */
export function zipRead(buf, opts = {}) {
  const maxEntryBytes = opts.maxEntryBytes ?? MAX_ENTRY_BYTES, maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES, maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip (too short)');
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  if (count > maxEntries) throw new Error('too many entries');
  let off = buf.readUInt32LE(eocd + 16);
  const out = []; let total = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    if (off + 46 + nlen > buf.length) throw new Error('bad central directory (name length)');
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    if (usize > maxEntryBytes) throw new Error(`entry too large: ${name} (${usize} bytes)`);
    total += usize; if (total > maxTotalBytes) throw new Error('zip too large (total)');
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error(`bad local header: ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new Error(`truncated entry: ${name}`);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = zlib.inflateRawSync(raw, { maxOutputLength: usize }); } catch (e) { if (e instanceof RangeError || e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`inflate exceeded declared size: ${name}`); throw e; } }
    else throw new Error(`unsupported compression method ${method}: ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch: ${name}`);
    if (!name.endsWith('/')) out.push({ name, data });
    off += 46 + nlen + xlen + clen;
  }
  return out;
}

/** [{ name, data, deflate?: true }] → zip 버퍼. 이름은 슬래시 구분, UTF-8 플래그(0x0800). deflate 미지정(false)=저장(0), true=deflate(8). */
export function zipWrite(entries) {
  const locals = [], centrals = []; let off = 0;
  for (const { name, data, deflate } of entries) {
    const nb = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data) >>> 0;
    const method = deflate ? 8 : 0;
    const payload = deflate ? zlib.deflateRawSync(data) : data;
    const csize = payload.length, usize = data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(method, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, payload); centrals.push(ch, nb); off += 30 + nb.length + csize;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(SIG_EOCD, 0); e.writeUInt16LE(0, 4); e.writeUInt16LE(0, 6); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16); e.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, e]);
}
