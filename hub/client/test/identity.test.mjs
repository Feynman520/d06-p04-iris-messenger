// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Supa } from '../supa.mjs';
import { Identity } from '../identity.mjs';
import { dpapiPlain } from '../dpapi.mjs';
import { b64, generateEntropy, entropyToMnemonic } from '../keys.mjs';
import { startMock } from './_mockhub.mjs';

test('Identity: mnemonic keys, profile create/restore/reset/rename', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-identity-'));
  const keysFile = path.join(stateDir, 'keys.bin');

  const supa = new Supa({ url: mock.url, anonKey: 'anon-key' });
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1', email: 'a@b.com' } });

  const identity = new Identity({ stateDir, supa, dpapi: dpapiPlain });

  // ① load() false (아직 keys.bin 없음)
  assert.equal(await identity.load(), false);

  // ② create('세준') → 12단어, keys.bin 존재, mock profile public_key = b64(publicRaw), key_version 1, 지문 8자
  const words = await identity.create('세준');
  assert.equal(words.length, 12);
  assert.equal(fssync.existsSync(keysFile), true);
  assert.equal(mock.store.profile.public_key, b64.enc(identity.publicRaw));
  assert.equal(mock.store.profile.key_version, 1);
  assert.equal(identity.fingerprint.length, 8);
  const firstPublicRaw = Buffer.from(identity.publicRaw);

  // ③ 새 인스턴스 load() true, 같은 publicRaw
  const identity2 = new Identity({ stateDir, supa, dpapi: dpapiPlain });
  assert.equal(await identity2.load(), true);
  assert.deepEqual(Buffer.from(identity2.publicRaw), firstPublicRaw);

  // ④ mnemonic() = ②의 단어
  const words2 = await identity2.mnemonic();
  assert.deepEqual(words2, words);

  // ⑤ keys.bin 삭제 후 restore(words) → 같은 publicRaw, 서버와 일치
  await fs.rm(keysFile, { force: true });
  const identity3 = new Identity({ stateDir, supa, dpapi: dpapiPlain });
  await identity3.restore(words);
  assert.deepEqual(Buffer.from(identity3.publicRaw), firstPublicRaw);
  assert.equal(mock.store.profile.public_key, b64.enc(identity3.publicRaw));
  assert.equal(fssync.existsSync(keysFile), true);

  // ⑥ 다른(무작위이지만 유효한) 단어로 restore → mismatch
  const identity4 = new Identity({ stateDir, supa, dpapi: dpapiPlain });
  const otherWords = entropyToMnemonic(generateEntropy());
  await assert.rejects(
    () => identity4.restore(otherWords),
    (e) => e.message === 'mismatch',
  );

  // ⑦ reset('세준') → key_version 2, 새 publicRaw
  const words3 = await identity3.reset('세준');
  assert.equal(words3.length, 12);
  assert.equal(mock.store.profile.key_version, 2);
  assert.notDeepEqual(Buffer.from(identity3.publicRaw), firstPublicRaw);
  assert.equal(mock.store.profile.public_key, b64.enc(identity3.publicRaw));

  // ⑧ rename('함세준') → mock profile display_name 갱신
  await identity3.rename('함세준');
  assert.equal(mock.store.profile.display_name, '함세준');
});
