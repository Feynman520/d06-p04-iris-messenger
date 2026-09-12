// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 메시지 흐름 시험: 보내기(봉투·outbox 재시도) · 받기(빈틈 메우기) · 파일 · 재연결 정책 V6/V7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { generateEntropy, deriveKeyPair } from '../../hub/client/keys.mjs';
import { seal } from '../../hub/client/crypto.mjs';
import { Messages, TEXT_MAX, FILE_MAX, RISKY_EXT } from '../messages.mjs';
import { FakeSupa, fakeTimers } from './_fakesupa.mjs';

function party() {
  const { privateRaw, publicRaw } = deriveKeyPair(generateEntropy());
  return { id: crypto.randomUUID(), privateRaw, publicRaw };
}

// 이 시험에서 필요한 만큼의 Contacts 대역(고정된 공개키 조회만). 실물 연동은 Task 11.
const contactsWith = (pairs) => {
  const map = new Map(pairs);
  return { publicKeyOf: (id) => map.get(id) || null, list: () => [...map.keys()].map((id) => ({ id })) };
};

function world(t) {
  const fake = new FakeSupa();
  const a = party();
  const b = party();
  const dirs = [];
  const tempDir = (tag) => {
    const d = fssync.mkdtempSync(path.join(os.tmpdir(), `iris-msg-${tag}-`));
    dirs.push(d);
    return d;
  };
  t.after(() => { for (const d of dirs) fssync.rmSync(d, { recursive: true, force: true }); });
  const make = async (self, other, stateDir, extra = {}) => {
    const m = new Messages({
      stateDir,
      supa: fake,
      identity: { privateRaw: self.privateRaw, publicRaw: self.publicRaw },
      contacts: contactsWith([[other.id, other.publicRaw]]),
      me: () => self.id,
      ...extra,
    });
    await m.load();
    t.after(() => m.stop());
    return m;
  };
  return { fake, a, b, tempDir, make };
}

test('상수: TEXT_MAX·FILE_MAX·RISKY_EXT는 화면이 쓸 수 있게 공개된다', () => {
  assert.equal(TEXT_MAX, 4000);
  assert.equal(FILE_MAX, 10 * 1024 * 1024);
  assert.ok(RISKY_EXT.test('setup.EXE'));
  assert.ok(RISKY_EXT.test('보고서.ps1'));
  assert.equal(RISKY_EXT.test('보고서.txt'), false);
});

test('① sendText: 로컬 sent 1건, 서버 1행, 본문에 평문 없음', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));

  const item = await A.sendText(b.id, '안녕');
  assert.equal(item.status, 'sent');
  assert.equal(item.dir, 'out');
  assert.equal(item.kind, 'text');

  const hist = A.history(b.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].text, '안녕');
  assert.equal(hist[0].status, 'sent');

  assert.equal(fake.rows.length, 1);
  const row = fake.rows[0];
  assert.equal(row.sender, a.id);
  assert.equal(row.recipient, b.id);
  assert.equal(row.client_id, item.id);
  assert.equal(row.body.includes('안녕'), false);
  assert.equal(Buffer.from(row.body, 'base64').toString('utf8').includes('안녕'), false);
});

test('② gapFill: 복호화·저장·delivered 표시·안 읽음 1 / ③ markRead → 0', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const events = [];
  const B = await make(b, a, tempDir('b'), { onEvent: (e) => events.push(e) });

  await A.sendText(b.id, '안녕');
  const n = await B.gapFill();
  assert.equal(n, 1);

  const hist = B.history(a.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].dir, 'in');
  assert.equal(hist[0].kind, 'text');
  assert.equal(hist[0].text, '안녕');
  assert.equal(hist[0].status, 'received');
  assert.equal(hist[0].read, false);
  assert.notEqual(fake.rows[0].delivered_at, null);
  assert.deepEqual(B.unread(), { total: 1, byPeer: { [a.id]: 1 } });
  assert.equal(events.filter((e) => e.type === 'message').length, 1);

  // ③ 읽음 처리
  await B.markRead(a.id);
  assert.equal(B.unread().total, 0);
  assert.ok(events.some((e) => e.type === 'badge' && e.count === 0));

  // 두 번째 gapFill은 미배달이 없으므로 0건, 기록도 늘지 않는다.
  assert.equal(await B.gapFill(), 0);
  assert.equal(B.history(a.id).length, 1);
});

test('④ V7: 실패 후 flushOutbox 재시도 — 같은 client_id로 서버 행이 늘지 않는다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));

  // 4a) 쓰기 전에 끊김 → pending, outbox 보관 → flushOutbox로 성공
  fake.failNext(1);
  const one = await A.sendText(b.id, '첫째');
  assert.equal(one.status, 'pending');
  assert.equal(fake.rows.length, 0);
  await A.flushOutbox();
  assert.equal(A.history(b.id).find((i) => i.id === one.id).status, 'sent');
  assert.equal(fake.rows.length, 1);

  // 4b) 쓰기는 됐는데 응답만 잃음 → 재시도가 409(23505) → sent, 행은 그대로 1행 추가뿐
  fake.failNext(1, { afterWrite: true });
  const two = await A.sendText(b.id, '둘째');
  assert.equal(two.status, 'pending');
  assert.equal(fake.rows.length, 2);
  await A.flushOutbox();
  assert.equal(A.history(b.id).find((i) => i.id === two.id).status, 'sent');
  assert.equal(fake.rows.length, 2);
  assert.equal(fake.rows.filter((r) => r.client_id === two.id).length, 1);

  // 3회 실패하면 failed로 중단하고 outbox에서 내린다.
  fake.failNext(3);
  const three = await A.sendText(b.id, '셋째');
  assert.equal(three.status, 'pending');
  await A.flushOutbox();
  await A.flushOutbox();
  assert.equal(A.history(b.id).find((i) => i.id === three.id).status, 'failed');
  await A.flushOutbox();
  assert.equal(fake.calls.insert, 7); // 2(4a) + 2(4b) + 3(셋째) — 그 뒤로는 재시도하지 않는다
});

test('⑤ 4,001자 글은 거부된다', async (t) => {
  const { a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  await assert.rejects(() => A.sendText(b.id, '가'.repeat(TEXT_MAX + 1)), /too long/);
  await assert.rejects(() => A.sendText(b.id, '   '), /empty/);
  assert.equal(A.history(b.id).length, 0);
});

test('⑥ 파일: Storage에 암호문만, 받는 쪽 fetchFile로 원본 복원', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const B = await make(b, a, tempDir('b'));

  const data = Buffer.from('비밀 서류 secret-marker', 'utf8');
  const sent = await A.sendFile(b.id, { name: 'a.txt', data });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.file.name, 'a.txt');
  assert.equal(sent.file.size, data.length);

  assert.equal(fake.storage.size, 1);
  const blob = [...fake.storage.values()][0];
  assert.equal(blob.includes('secret-marker'), false);
  assert.equal([...fake.storage.keys()][0], `files/${a.id}/${sent.id}`);

  await B.gapFill();
  const got = B.history(a.id)[0];
  assert.equal(got.kind, 'file');
  assert.equal(got.file.name, 'a.txt');
  assert.equal(got.file.size, data.length);
  assert.equal(got.file.savedPath, undefined); // 자동 내려받기 없음

  const saved = await B.fetchFile(got.id);
  assert.ok(fssync.readFileSync(saved).equals(data));
  assert.equal(B.history(a.id)[0].file.savedPath, saved);
  // 두 번째 호출은 이미 받은 파일을 그대로 돌려준다(내려받기 1회).
  assert.equal(await B.fetchFile(got.id), saved);
  assert.equal(fake.calls.download, 1);

  await assert.rejects(() => A.sendFile(b.id, { name: 'big', data: Buffer.alloc(FILE_MAX + 1) }), /too large/);
});

test('⑦ V6: 웹소켓이 끊긴 사이 온 2건을 재연결 gapFill로 메운다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const timers = fakeTimers();
  const A = await make(a, b, tempDir('a'));
  const B = await make(b, a, tempDir('b'), { timers });

  await B.start();
  assert.equal(B.connection, 'online');

  fake.drop(); // 웹소켓 끊김
  assert.equal(B.connection, 'offline');

  await A.sendText(b.id, 'one');
  await A.sendText(b.id, 'two');
  await B.settle();
  assert.equal(B.history(a.id).length, 0, '끊긴 동안에는 도어벨이 울리지 않는다');

  const retry = timers.pending().filter((x) => x.kind === 'timeout');
  assert.equal(retry.length, 1);
  assert.equal(retry[0].ms, 1000, '백오프는 1초부터');
  await timers.fire(retry[0].id);
  await B.settle();

  assert.equal(B.history(a.id).length, 2);
  assert.deepEqual(B.history(a.id).map((i) => i.text), ['one', 'two']);
  assert.equal(B.connection, 'online');
  assert.equal(B.unread().total, 2);

  // 이어서 도어벨(실시간)로도 들어온다.
  await A.sendText(b.id, 'three');
  await B.settle();
  assert.equal(B.history(a.id).length, 3);
});

test('⑧ 모르는 봉투 버전은 unsupported로 보관하고 delivered 처리한다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const B = await make(b, a, tempDir('b'));

  const body = seal({ senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw, envelope: { v: 9, kind: 'hologram' } });
  fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'text', body });

  assert.equal(await B.gapFill(), 1);
  const item = B.history(a.id)[0];
  assert.equal(item.status, 'unsupported');
  assert.equal(item.text, undefined);
  assert.notEqual(fake.rows[0].delivered_at, null);
});

test('⑨ 연락처가 아닌 보낸 이의 줄은 failed로 보관하고 delivered 처리한다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const stranger = party();
  const B = await make(b, a, tempDir('b'));

  const body = seal({ senderPrivateRaw: stranger.privateRaw, senderPublicRaw: stranger.publicRaw, recipientPublicRaw: b.publicRaw, envelope: { v: 1, kind: 'text', text: '낚시' } });
  fake.insertRow({ client_id: crypto.randomUUID(), sender: stranger.id, recipient: b.id, kind: 'text', body });

  assert.equal(await B.gapFill(), 1);
  const item = B.history(stranger.id)[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.error, 'unknown sender');
  assert.equal(item.text, undefined);
  assert.notEqual(fake.rows[0].delivered_at, null);
});

test('⑩ 재시작해도 기록이 남는다(ndjson) + 열 수 없는 봉투는 failed', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const dirB = tempDir('b');
  const B = await make(b, a, dirB);

  await A.sendText(b.id, '안녕');
  await A.sendFile(b.id, { name: '보고서.txt', data: Buffer.from('내용') });
  // 변조된 봉투 하나(열쇠는 맞지만 내용이 깨짐)
  const good = seal({ senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw, envelope: { v: 1, kind: 'text', text: 'x' } });
  const buf = Buffer.from(good, 'base64');
  buf[1 + 32 + 12 + 1] ^= 0xff;
  fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'text', body: buf.toString('base64') });

  await B.gapFill();
  await B.markRead(a.id);
  const before = B.history(a.id);
  assert.equal(before.length, 3);
  assert.equal(before[2].status, 'failed');
  assert.equal(before[2].error, 'cannot open');

  const B2 = new Messages({
    stateDir: dirB,
    supa: fake,
    identity: { privateRaw: b.privateRaw, publicRaw: b.publicRaw },
    contacts: contactsWith([[a.id, a.publicRaw]]),
    me: () => b.id,
  });
  await B2.load();
  assert.deepEqual(B2.history(a.id).map((i) => [i.id, i.status, i.read]), before.map((i) => [i.id, i.status, i.read]));
  assert.equal(B2.unread().total, 0);
  assert.equal(B2.history(a.id)[1].file.name, '보고서.txt');
});

test('⑪ 웹소켓 3회 연속 실패 → slow + 60초 폴링, stop()이 타이머를 거둔다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const timers = fakeTimers();
  const states = [];
  const B = await make(b, a, tempDir('b'), { timers, onEvent: (e) => { if (e.type === 'connection') states.push(e.state); } });

  fake.wsMode = 'error';
  await B.start();
  assert.equal(B.connection, 'offline');
  assert.equal(timers.pending().filter((x) => x.kind === 'timeout')[0].ms, 1000);

  await timers.fireFirst('timeout'); // 2회째 실패 → 2초 백오프
  await B.settle();
  assert.equal(B.connection, 'offline');
  assert.equal(timers.pending().filter((x) => x.kind === 'timeout')[0].ms, 2000);

  await timers.fireFirst('timeout'); // 3회째 실패 → 느린 연결
  await B.settle();
  assert.equal(B.connection, 'slow');
  const poll = timers.pending().filter((x) => x.kind === 'interval');
  assert.equal(poll.length, 1);
  assert.equal(poll[0].ms, 60000, '60초 폴링');
  const retryWs = timers.pending().filter((x) => x.kind === 'timeout');
  assert.equal(retryWs.length, 1);
  assert.equal(retryWs[0].ms, 600000, '10분마다 웹소켓 재시도');

  // 폴링이 실제로 gapFill을 돈다
  const A = await make(a, b, tempDir('a'));
  await A.sendText(b.id, '폴링으로 도착');
  await timers.fire(poll[0].id);
  await B.settle();
  assert.equal(B.history(a.id).length, 1);

  B.stop();
  assert.equal(B.connection, 'stopped');
  assert.deepEqual(timers.pending(), []);
  assert.deepEqual(states, ['offline', 'slow', 'stopped'], '같은 상태는 다시 알리지 않는다');
});
