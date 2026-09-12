// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Supa, SupaError } from '../supa.mjs';
import { Session } from '../session.mjs';
import { dpapiPlain } from '../dpapi.mjs';
import { writeFileAtomic } from '../store.mjs';
import { startMock } from './_mockhub.mjs';

test('Session: OTP login lifecycle, lockout, persistence, logout, delete', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-session-'));
  t.after(() => fssync.rmSync(stateDir, { recursive: true, force: true }));
  const authFile = path.join(stateDir, 'auth.bin');
  const email = 'a@b.com';

  const supa = new Supa({ url: mock.url, anonKey: 'anon-key' });
  const session = new Session({ stateDir, supa, dpapi: dpapiPlain });

  // ① 로그인 전 load() false
  assert.equal(await session.load(), false);

  // ② requestCode('bad') → throw (형식 검사만으로 거부, 네트워크 호출 없음)
  await assert.rejects(() => session.requestCode('bad'));
  assert.equal(mock.calls.otp.length, 0);

  // ③ verifyCode(email, '000000') 실패 ×5 → 6번째 locked
  await session.requestCode(email);
  assert.equal(mock.calls.otp.length, 1);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => session.verifyCode(email, '000000'),
      (e) => e.message !== 'locked',
    );
  }
  await assert.rejects(
    () => session.verifyCode(email, '000000'),
    (e) => e.message === 'locked',
  );

  // ④ requestCode 후 verifyCode(email, '123456') 성공 → auth.bin 존재, user.id === 'u1'
  await session.requestCode(email);
  const user = await session.verifyCode(email, '123456');
  assert.equal(user.id, 'u1');
  assert.equal(fssync.existsSync(authFile), true);
  assert.equal(session.user.id, 'u1');

  // ⑤ 새 Session 인스턴스 load() true (supa.session.access_token === 'at1')
  const supa2 = new Supa({ url: mock.url, anonKey: 'anon-key' });
  const session2 = new Session({ stateDir, supa: supa2, dpapi: dpapiPlain });
  assert.equal(await session2.load(), true);
  assert.equal(supa2.session.access_token, 'at1');

  // ⑥ logout → auth.bin 없음, load() false
  await session2.logout();
  assert.equal(fssync.existsSync(authFile), false);
  assert.equal(await session2.load(), false);

  // ⑦ deleteAccount → stateDir 비어 있음 (미리 넣어 둔 messages/x.ndjson 포함 삭제)
  await fs.mkdir(path.join(stateDir, 'messages'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'messages', 'x.ndjson'), 'line\n');
  await session.deleteAccount();
  const remaining = await fs.readdir(stateDir);
  assert.deepEqual(remaining, []);
});

test('Session: bad-shaped code (not 6-digit, not a link) is rejected without calling the server', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-session-'));
  t.after(() => fssync.rmSync(stateDir, { recursive: true, force: true }));
  const supa = new Supa({ url: mock.url, anonKey: 'anon-key' });
  const session = new Session({ stateDir, supa, dpapi: dpapiPlain });
  await session.requestCode('a@b.com');
  await assert.rejects(
    () => session.verifyCode('a@b.com', 'not-a-code'),
    (e) => e.message === 'bad code',
  );
  assert.equal(mock.calls.verify.length, 0);
});

test('Session: load() clears auth.bin and returns false when refresh fails with 403', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-session-'));
  t.after(() => fssync.rmSync(stateDir, { recursive: true, force: true }));
  const authFile = path.join(stateDir, 'auth.bin');

  // 만료된 세션을 auth.bin에 미리 심어 둔다(dpapiPlain 통과 형식과 동일하게).
  const seeded = {
    access_token: 'at-old',
    refresh_token: 'rt-old',
    expires_at: Math.floor(Date.now() / 1000) - 10,
    user: { id: 'u1', email: 'a@b.com' },
  };
  const enc = await dpapiPlain.protect(Buffer.from(JSON.stringify(seeded), 'utf8'));
  await writeFileAtomic(authFile, enc);

  const supa = new Supa({ url: mock.url, anonKey: 'anon-key' });
  // refresh()가 403(금지)로 실패하는 상황을 주입한다.
  supa.refresh = async () => {
    throw new SupaError('forbidden', { status: 403 });
  };
  const session = new Session({ stateDir, supa, dpapi: dpapiPlain });

  assert.equal(await session.load(), false);
  assert.equal(fssync.existsSync(authFile), false);
  // 파일뿐 아니라 메모리의 세션도 비워야 한다(로그인한 것처럼 보이면 안 된다).
  assert.equal(supa.session, null);
  assert.equal(session.user, null);
});
