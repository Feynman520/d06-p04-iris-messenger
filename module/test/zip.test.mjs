// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// scripts/lib/zip.mjs 시험: 로컬 헤더의 자리(규격 offset 8=압축방식, 10~13=시각·날짜)와 왕복.
// 파이썬·외부 도구 없이 바이트를 직접 읽어 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipWrite, zipRead } from '../../scripts/lib/zip.mjs';

const SIG_LOCAL = 0x04034b50;

// 로컬 헤더 한 장을 손으로 뜯어 읽는다(라이브러리를 믿지 않고 규격대로).
function readLocalHeader(buf, off = 0) {
  assert.equal(buf.readUInt32LE(off), SIG_LOCAL, 'local file header signature');
  const nlen = buf.readUInt16LE(off + 26);
  const xlen = buf.readUInt16LE(off + 28);
  return {
    version: buf.readUInt16LE(off + 4),
    flags: buf.readUInt16LE(off + 6),
    method: buf.readUInt16LE(off + 8),
    modTime: buf.readUInt16LE(off + 10),
    modDate: buf.readUInt16LE(off + 12),
    crc: buf.readUInt32LE(off + 14),
    csize: buf.readUInt32LE(off + 18),
    usize: buf.readUInt32LE(off + 22),
    nlen,
    xlen,
    name: buf.subarray(off + 30, off + 30 + nlen).toString('utf8'),
    dataAt: off + 30 + nlen + xlen,
  };
}

test('① deflate 항목의 로컬 헤더: offset 8 = 8(deflate), 10~13 = 0', () => {
  // 같은 바이트가 되풀이돼야 deflate가 실제로 줄인다(압축 방식이 헤더대로인지 보려면 필요).
  const data = Buffer.from('가나다라 '.repeat(200), 'utf8');
  const zip = zipWrite([{ name: 'lib/한글.mjs', data, deflate: true }]);

  const lh = readLocalHeader(zip, 0);
  assert.equal(lh.method, 8, 'offset 8 은 압축 방식이다(deflate=8)');
  assert.equal(lh.modTime, 0, 'offset 10 은 수정 시각 자리 — 0');
  assert.equal(lh.modDate, 0, 'offset 12 는 수정 날짜 자리 — 0');
  // 옛 버그(방식을 10에 쓰던 때)라면 8~9가 0이고 10~11이 8이었다.
  assert.equal(zip.readUInt16LE(8), 8);
  for (let i = 10; i <= 13; i += 1) assert.equal(zip[i], 0, `byte ${i} 는 0이어야 한다`);

  assert.equal(lh.flags, 0x0800, 'UTF-8 이름 플래그');
  assert.equal(lh.name, 'lib/한글.mjs');
  assert.equal(lh.usize, data.length);
  assert.ok(lh.csize < data.length, '실제로 줄었다(deflate가 걸렸다)');
});

test('② 저장(deflate 없음) 항목은 offset 8 = 0, 시각·날짜는 그대로 0', () => {
  const data = Buffer.from('stored', 'utf8');
  const zip = zipWrite([{ name: 'a.txt', data }]);
  const lh = readLocalHeader(zip, 0);
  assert.equal(lh.method, 0);
  assert.equal(lh.modTime, 0);
  assert.equal(lh.modDate, 0);
  assert.equal(lh.csize, data.length);
  assert.equal(zip.subarray(lh.dataAt, lh.dataAt + data.length).toString('utf8'), 'stored');
});

test('③ zipRead 왕복: 섞인 여러 항목이 이름·바이트 그대로 돌아온다', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"v":1}', 'utf8'), deflate: true },
    { name: 'lib/keys.mjs', data: Buffer.from('export const k = 1;\n'.repeat(50), 'utf8'), deflate: true },
    { name: 'bin.dat', data: Buffer.from([0, 1, 2, 253, 254, 255]) },
  ];
  const zip = zipWrite(entries);
  const back = zipRead(zip);
  assert.equal(back.length, entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(back[i].name, entries[i].name);
    assert.ok(back[i].data.equals(entries[i].data), `${entries[i].name} 바이트가 같다`);
  }

  // 두 번째 항목의 로컬 헤더도 같은 규격이다(첫 장만 맞는 것이 아님).
  const first = readLocalHeader(zip, 0);
  const second = readLocalHeader(zip, first.dataAt + first.csize);
  assert.equal(second.name, 'lib/keys.mjs');
  assert.equal(second.method, 8);
  assert.equal(second.modTime, 0);
  assert.equal(second.modDate, 0);
});
