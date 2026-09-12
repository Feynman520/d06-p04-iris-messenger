// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { protect, unprotect } from '../dpapi.mjs';

test('① round trip: Korean + emoji buffer survives protect→unprotect', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI is Windows-only');
  const plain = Buffer.from('비밀 🙂', 'utf8');
  const enc = await protect(plain);
  const dec = await unprotect(enc);
  assert.deepEqual(dec, plain);
});

test('② protect output differs from plaintext and is longer', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI is Windows-only');
  const plain = Buffer.from('hello dpapi', 'utf8');
  const enc = await protect(plain);
  assert.equal(enc.equals(plain), false);
  assert.ok(enc.length > plain.length);
});

test('③ 100KB random buffer round trips exactly', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI is Windows-only');
  const plain = crypto.randomBytes(100 * 1024);
  const enc = await protect(plain);
  const dec = await unprotect(enc);
  assert.deepEqual(dec, plain);
});

test('④ tampered blob rejects on unprotect', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI is Windows-only');
  const plain = Buffer.from('tamper me please', 'utf8');
  const enc = await protect(plain);
  const bad = Buffer.from(enc);
  bad[bad.length - 1] ^= 0xff;
  await assert.rejects(() => unprotect(bad));
});
