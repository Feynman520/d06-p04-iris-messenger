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
import { Messages, TEXT_MAX, FILE_MAX, RISKY_EXT, SAVE_DIR_NAME, findIrisRoot, folderName } from '../messages.mjs';
import { FakeSupa, fakeTimers } from './_fakesupa.mjs';

function party() {
  const { privateRaw, publicRaw } = deriveKeyPair(generateEntropy());
  return { id: crypto.randomUUID(), privateRaw, publicRaw };
}

// 조건이 참이 될 때까지 짧게 기다린다(디스크 쓰기처럼 await할 손잡이가 없는 경우).
async function waitFor(fn, { timeout = 2000, step = 5 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor: 시간 안에 조건이 참이 되지 않았다');
}

// 이 시험에서 필요한 만큼의 Contacts 대역(고정된 공개키 조회만). 실물 연동은 app.mjs 가 맡는다.
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

test('⑫ 도어벨과 폴링이 겹쳐도 mark_delivered를 두 번 부르지 않는다(동시 gapFill 직렬화)', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const events = [];
  const B = await make(b, a, tempDir('b'), { onEvent: (e) => events.push(e) });

  await A.sendText(b.id, '한 통');
  const rpcBefore = fake.calls.rpc;
  const [n1, n2, n3] = await Promise.all([B.gapFill(), B.gapFill(), B.gapFill()]);
  assert.equal(n1, 1);
  assert.equal(n2 + n3, 0, '뒤이은 호출은 이미 배달 처리된 뒤라 0건 — 같은 줄을 다시 집지 않는다');
  assert.equal(fake.calls.rpc - rpcBefore, 1, 'mark_delivered는 한 번만');
  assert.equal(B.history(a.id).length, 1);
  assert.equal(events.filter((e) => e.type === 'message').length, 1);
});

test('⑬ 겹친 flushOutbox는 같은 편지로 INSERT를 두 번 쏘지 않는다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));

  fake.failNext(1);
  await A.sendText(b.id, '대기 중');
  const before = fake.calls.insert;
  await Promise.all([A.flushOutbox(), A.flushOutbox(), A.flushOutbox()]);
  assert.equal(fake.calls.insert - before, 1, '보낼 것이 하나면 INSERT도 한 번');
  assert.equal(fake.rows.length, 1);
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

// ── 검토 지적 반영(fix round 1) ─────────────────────────────────────────────

test('⑭ 화면 콜백이 터져도 편지는 남는다 — 기록 먼저, 알림 나중', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const dirB = tempDir('b');
  let boom = 1;
  const logs = [];
  const B = await make(b, a, dirB, {
    log: (m) => logs.push(m),
    onEvent: (e) => { if (e.type === 'message' && boom-- > 0) throw new Error('화면 폭발'); },
  });

  await A.sendText(b.id, '잃으면 안 되는 편지');
  await B.gapFill(); // 콜백이 터져도 던지지 않는다

  const file = path.join(dirB, 'messages', `${a.id}.ndjson`);
  const onDisk = fssync.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(onDisk.length, 1, 'ndjson에 편지가 남아 있어야 한다');
  assert.equal(onDisk[0].text, '잃으면 안 되는 편지');
  assert.notEqual(fake.rows[0].delivered_at, null, '배달 표시도 남는다');
  assert.ok(logs.some((m) => m.startsWith('onEvent(')), '콜백 오류는 로그로만 남는다');

  // 두 번째 gapFill이 와도(서버엔 이미 배달됨) 기록은 그대로 한 통
  assert.equal(await B.gapFill(), 0);
  assert.equal(B.history(a.id).length, 1);

  const B2 = new Messages({ stateDir: dirB, supa: fake, identity: { privateRaw: b.privateRaw, publicRaw: b.publicRaw }, contacts: contactsWith([[a.id, a.publicRaw]]), me: () => b.id });
  await B2.load();
  assert.equal(B2.history(a.id)[0].text, '잃으면 안 되는 편지');
});

test('⑮ 보내기는 outbox 먼저 — 네트워크가 멈춰 있어도 pending 기록과 예약이 남는다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const dirA = tempDir('a');
  // insert가 영원히 응답하지 않는 허브(가짜를 감싸기만 한다 — _fakesupa.mjs는 건드리지 않는다)
  const hung = {
    select: (...x) => fake.select(...x),
    insert: () => new Promise(() => {}),
    rpc: (...x) => fake.rpc(...x),
    upload: (...x) => fake.upload(...x),
    download: (...x) => fake.download(...x),
    subscribe: (o) => fake.subscribe(o),
  };
  const A = await make(a, b, dirA, { supa: hung });

  const inFlight = A.sendText(b.id, '멈춘 편지'); // 일부러 기다리지 않는다
  inFlight.catch(() => {});

  const msgFile = path.join(dirA, 'messages', `${b.id}.ndjson`);
  const outFile = path.join(dirA, 'outbox.json');
  await waitFor(() => fssync.existsSync(msgFile) && fssync.existsSync(outFile));

  const onDisk = JSON.parse(fssync.readFileSync(msgFile, 'utf8').trim());
  assert.equal(onDisk.status, 'pending');
  assert.equal(onDisk.text, '멈춘 편지');
  const outbox = JSON.parse(fssync.readFileSync(outFile, 'utf8'));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, onDisk.id);
  assert.equal(outbox[0].peer, b.id);
  assert.ok(outbox[0].row.body, '재시도에 쓸 암호문이 함께 있다');
  assert.equal(fake.rows.length, 0, '서버에는 아직 아무것도 없다');

  // 다음 실행이 이어받는다: 멀쩡한 허브로 새 인스턴스를 띄우면 flushOutbox가 보낸다
  const A2 = new Messages({ stateDir: dirA, supa: fake, identity: { privateRaw: a.privateRaw, publicRaw: a.publicRaw }, contacts: contactsWith([[b.id, b.publicRaw]]), me: () => a.id });
  await A2.load();
  await A2.flushOutbox();
  assert.equal(fake.rows.length, 1);
  assert.equal(A2.history(b.id)[0].status, 'sent');
  assert.deepEqual(JSON.parse(fssync.readFileSync(outFile, 'utf8')), []);
});

test('⑯ gapFill 쪽 넘기기: 201통도 한 번의 호출로 전부 받는다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const B = await make(b, a, tempDir('b'));

  for (let i = 0; i < 201; i += 1) {
    const body = seal({ senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw, envelope: { v: 1, kind: 'text', text: `편지 ${i}` } });
    fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'text', body });
  }

  const before = fake.calls.select;
  assert.equal(await B.gapFill(), 201);
  assert.equal(fake.calls.select - before, 2, '200 + 1 두 쪽');
  const hist = B.history(a.id, { limit: 1000 });
  assert.equal(hist.length, 201);
  assert.equal(hist[0].text, '편지 0');
  assert.equal(hist[200].text, '편지 200');
  assert.equal(fake.rows.filter((r) => r.delivered_at == null).length, 0, '전부 배달 표시');
  assert.equal(await B.gapFill(), 0);
});

test('⑰ 봉투의 파일 주소가 보낸 이 칸이 아니면 거절한다(bad file path)', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const outsider = party();
  const B = await make(b, a, tempDir('b'));

  const bad = [
    `${outsider.id}/${crypto.randomUUID()}`, // 남의 칸
    `${a.id}/../${b.id}/${crypto.randomUUID()}`, // 경로 빠져나가기
    `${a.id}/not-a-uuid`,
    '',
  ];
  for (const storagePath of bad) {
    const body = seal({
      senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw,
      envelope: { v: 1, kind: 'file', name: 'x.txt', size: 10, key: 'AAAA', storagePath },
    });
    fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'file', body });
  }
  await B.gapFill();

  const items = B.history(a.id);
  assert.equal(items.length, bad.length);
  for (const it of items) {
    assert.equal(it.status, 'failed');
    assert.equal(it.error, 'bad file path');
    await assert.rejects(() => B.fetchFile(it.id), /bad file path/, '받기 버튼도 같은 자리에서 막힌다');
  }
  assert.equal(fake.calls.download, 0, '거절한 주소는 내려받지 않는다');
  assert.equal(fake.rows.filter((r) => r.delivered_at == null).length, 0);
});

test('⑱ 약속한 크기보다 큰 파일은 내려받아도 받아들이지 않는다(file too large)', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const B = await make(b, a, tempDir('b'));

  // A가 정상적으로 올린 1KB 파일
  const data = Buffer.alloc(1024, 7);
  const real = await A.sendFile(b.id, { name: 'real.bin', data });

  // 같은 자리를 가리키면서 "5바이트짜리"라고 우기는 편지
  const body = seal({
    senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw,
    envelope: { v: 1, kind: 'file', name: 'liar.bin', size: 5, key: real.file.key, storagePath: real.file.storagePath },
  });
  fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'file', body, file_path: real.file.storagePath });

  await B.gapFill();
  const [honest, liar] = B.history(a.id);
  assert.equal(honest.status, 'received');
  assert.equal(liar.file.size, 5);
  await assert.rejects(() => B.fetchFile(liar.id), /file too large/);
  // 정직한 쪽은 그대로 받아진다
  assert.ok(fssync.readFileSync(await B.fetchFile(honest.id)).equals(data));

  // 봉투가 아예 10MB 초과를 주장하면 받는 즉시 failed
  const huge = seal({
    senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw,
    envelope: { v: 1, kind: 'file', name: 'huge.bin', size: FILE_MAX + 1, key: real.file.key, storagePath: `${a.id}/${crypto.randomUUID()}` },
  });
  fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'file', body: huge });
  await B.gapFill();
  const last = B.history(a.id).at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(last.error, 'file too large');
});

// ── 검토 지적 반영(fix wave 1, 2026-09-13) ──────────────────────────────────

test('⑲ markRead는 바뀐 것이 없어도 배지를 다시 알리고, history()는 사본을 준다', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const A = await make(a, b, tempDir('a'));
  const events = [];
  const B = await make(b, a, tempDir('b'), { onEvent: (e) => events.push(e) });

  // 읽을 것이 하나도 없는 상대에게 markRead — 그래도 badge 한 번.
  await B.markRead(a.id);
  assert.deepEqual(events.filter((e) => e.type === 'badge'), [{ type: 'badge', count: 0 }]);

  await A.sendText(b.id, '한 통');
  await B.gapFill();
  await B.markRead(a.id);                                  // 실제로 바뀜 → 배지
  await B.markRead(a.id);                                  // 이미 다 읽음 → 그래도 배지
  assert.equal(events.filter((e) => e.type === 'badge' && e.count === 0).length, 3);

  // 돌려받은 항목을 고쳐도 우리 기록은 그대로다.
  const got = B.history(a.id);
  got[0].text = '바꿔치기';
  got[0].read = false;
  assert.equal(B.history(a.id)[0].text, '한 통');
  assert.equal(B.unread().total, 0);
});

// ── 검토 지적 반영(fix wave 2, 2026-09-13) ─────────────────────────────────

test('㉑ 연결돼 있는 동안 2초·2분 안전망 gapFill이 돈다(끊기면 거둔다)', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const timers = fakeTimers();
  const B = await make(b, a, tempDir('b'), { timers });

  await B.start();
  assert.equal(B.connection, 'online');
  const soon = timers.pending().find((x) => x.kind === 'timeout' && x.ms === 2000);
  const safety = timers.pending().find((x) => x.kind === 'interval' && x.ms === 120000);
  assert.ok(soon, 'ack 직후 2초 뒤 한 번 더 훑는다');
  assert.ok(safety, '연결돼 있는 동안 2분마다 훑는다');

  const before = fake.calls.select;
  await timers.fire(soon.id);
  await B.settle();
  assert.ok(fake.calls.select > before, '2초 타이머가 실제로 gapFill을 돈다');

  const before2 = fake.calls.select;
  await timers.fire(safety.id);
  await B.settle();
  assert.ok(fake.calls.select > before2, '2분 타이머도 실제로 gapFill을 돈다');

  // 끊기면 안전망은 거두고, 재연결·폴링 쪽 타이머만 남는다.
  fake.drop();
  assert.equal(B.connection, 'offline');
  assert.equal(timers.pending().filter((x) => x.ms === 2000 || x.ms === 120000).length, 0, '끊기면 안전망을 거둔다');

  B.stop();
  assert.deepEqual(timers.pending(), [], 'stop()이 남은 타이머를 모두 거둔다');
});

test('⑳ 파일 주소의 uuid는 정규형만 받는다(대문자·자리수 어긋남 거절)', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const B = await make(b, a, tempDir('b'));

  const bad = [
    `${a.id}/${crypto.randomUUID().toUpperCase()}`,        // 대문자
    `${a.id}/${'0'.repeat(8)}-0000-0000-0000-00000000000`, // 한 자리 모자람
    `${a.id}/----------------------------------aa`,        // 길이만 맞는 쓰레기
  ];
  for (const storagePath of bad) {
    const body = seal({
      senderPrivateRaw: a.privateRaw, senderPublicRaw: a.publicRaw, recipientPublicRaw: b.publicRaw,
      envelope: { v: 1, kind: 'file', name: 'x.txt', size: 10, key: 'AAAA', storagePath },
    });
    fake.insertRow({ client_id: crypto.randomUUID(), sender: a.id, recipient: b.id, kind: 'file', body });
  }
  await B.gapFill();

  const items = B.history(a.id);
  assert.equal(items.length, bad.length);
  for (const it of items) assert.equal(it.error, 'bad file path');
  assert.equal(fake.calls.download, 0);
});

// 0.4.0: 받은 파일은 IRIS 루트 밑 _messenger\<상대 이름>\ 에 원래 이름으로. 루트는 Face와 같은 규칙(_agent 표지)으로 찾는다.
test('㉒ 받은 파일 자리: IRIS 루트를 찾으면 _messenger\\<상대 이름>\\원래이름, 겹치면 (2), 이름의 금지 글자는 _', async (t) => {
  const { fake, a, b, tempDir, make } = world(t);
  const root = tempDir('root');
  fssync.mkdirSync(path.join(root, '_agent'));                           // IRIS 루트 표지
  const stateB = path.join(root, 'R07', 'P02', 'modules', 'messenger', 'state', 'accounts', b.id);
  fssync.mkdirSync(stateB, { recursive: true });
  assert.equal(findIrisRoot(stateB, {}), root, '상태 폴더에서 위로 올라가 _agent 가 있는 폴더');
  assert.equal(findIrisRoot(tempDir('lonely'), {}), null, '표지가 없으면 null(상태 폴더에 저장)');
  assert.equal(findIrisRoot(stateB, { IRIS_ROOT: root }), root, '환경변수가 먼저');
  assert.equal(folderName(' a/b:c*d?e"f<g>h|i. '), 'a_b_c_d_e_f_g_h_i');
  assert.equal(folderName(''), '이름 모름');

  const A = await make(a, b, tempDir('a'));
  const contacts = { publicKeyOf: () => a.publicRaw, list: () => [{ id: a.id }], get: () => ({ id: a.id, displayName: '똥/개' }) };
  const B = await make(b, a, stateB, { contacts });
  assert.equal(B.saveRoot, root);

  const data = Buffer.from('첫 번째', 'utf8');
  await A.sendFile(b.id, { name: 'a.txt', data });
  await A.sendFile(b.id, { name: 'a.txt', data: Buffer.from('두 번째', 'utf8') });
  await B.gapFill();
  const [first, second] = B.history(a.id);
  const p1 = await B.fetchFile(first.id);
  const p2 = await B.fetchFile(second.id);
  assert.equal(p1, path.join(root, SAVE_DIR_NAME, '똥_개', 'a.txt'));
  assert.equal(p2, path.join(root, SAVE_DIR_NAME, '똥_개', 'a (2).txt'));
  assert.equal(fssync.readFileSync(p1, 'utf8'), '첫 번째');
  assert.equal(fssync.readFileSync(p2, 'utf8'), '두 번째');
  assert.equal(fssync.existsSync(path.join(stateB, 'files')), false, '루트를 찾았으면 상태 폴더에는 쓰지 않는다');

  // 루트를 못 찾는 설치(saveRoot null)는 예전처럼 상태 폴더 files\ 에.
  const C = await make(b, a, tempDir('c'), { contacts, saveRoot: null });
  await A.sendFile(b.id, { name: 'a.txt', data });   // B 가 이미 받아 간 줄은 다시 오지 않으므로 새로 한 통
  await C.gapFill();
  const p3 = await C.fetchFile(C.history(a.id)[0].id);
  assert.equal(path.dirname(p3), C.filesDir);
  assert.equal(path.basename(p3), 'a.txt');
});
