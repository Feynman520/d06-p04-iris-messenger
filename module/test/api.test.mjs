// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 로컬 HTTP/SSE 화면 API 시험: 토큰 문지기 · 상태 기계(out→code→identity→in) · SSE · 업로드 상한 · 설정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { dpapiPlain } from '../../hub/client/dpapi.mjs';
import { deriveKeyPair, mnemonicToEntropy, entropyToMnemonic, generateEntropy, b64 } from '../../hub/client/keys.mjs';
import { FILE_MAX, TEXT_MAX } from '../messages.mjs';
import { App, CONTACTS_SYNC_MS, CONTACTS_SYNC_GAP_MS } from '../app.mjs';
import { createHandler } from '../api.mjs';
import { FakeSupa, fakeTimers } from './_fakesupa.mjs';

const PRIVACY = '<!doctype html><meta charset="utf-8"><title>privacy</title><p>policy</p>';
const PANEL = '<!doctype html><meta charset="utf-8"><title>IRIS Messenger</title><p>panel pending</p>';
const TOKEN = 'deadbeefcafe0123';

// App(가짜 허브·가짜 DPAPI) + createHandler를 실제 http 서버에 붙인 한 벌.
async function world(t, appOpts = {}) {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-api-'));
  const fake = new FakeSupa();
  const app = new App({ makeSupa: () => fake, dpapi: dpapiPlain, log: () => {}, ...appOpts });
  await app.init({ stateDir: dir });
  const sent = [];
  const logs = [];
  const server = http.createServer(createHandler({ app, token: TOKEN, panelHtml: PANEL, privacyHtml: PRIVACY, out: (o) => sent.push(o), log: (m) => logs.push(m) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await app.shutdown();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fssync.rmSync(dir, { recursive: true, force: true });
  });

  const api = (p, { method = 'GET', body, token = TOKEN, raw = false } = {}) => {
    const headers = {};
    if (token) headers['x-token'] = token;
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    return fetch(base + p, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  };
  const json = async (p, o) => { const r = await api(p, o); return { status: r.status, body: await r.json() }; };
  const state = async () => (await json('/api/state')).body;
  // 계정 자료는 stateDir\accounts\<사용자 번호>\ 아래에만 쌓인다.
  const acct = (uid, ...rest) => path.join(dir, 'accounts', uid, ...rest);

  return { dir, fake, app, base, api, json, state, sent, logs, acct };
}

// 로그인 + 신원까지 마쳐 stage 'in'으로 만든다.
async function signIn(w) {
  await w.json('/api/login/email', { method: 'POST', body: { email: 'me@example.com' } });
  await w.json('/api/login/code', { method: 'POST', body: { email: 'me@example.com', code: '123456' } });
  return w.json('/api/identity', { method: 'POST', body: { displayName: '나' } });
}

test('① 토큰 없이 / 를 열면 403', async (t) => {
  const w = await world(t);
  const r = await w.api('/', { token: null });
  assert.equal(r.status, 403);

  const wrong = await w.api('/api/state', { token: 'nope' });
  assert.equal(wrong.status, 403);

  // 쿼리 토큰(?t=)도 같은 값이어야 한다.
  assert.equal((await fetch(`${w.base}/?t=wrong`)).status, 403);

  // 글자 수는 같지만 바이트 수가 다른 토큰(한글 16자)에도 터지지 않고 403을 준다.
  // (헤더에는 한글을 실을 수 없으므로 주소의 ?t= 로만 온다.)
  const wide = '가'.repeat(TOKEN.length);
  assert.equal(wide.length, TOKEN.length);
  assert.notEqual(Buffer.byteLength(wide, 'utf8'), Buffer.byteLength(TOKEN, 'utf8'));
  assert.equal((await fetch(`${w.base}/?t=${encodeURIComponent(wide)}`)).status, 403);
  assert.equal((await fetch(`${w.base}/api/state?t=${encodeURIComponent(wide)}`)).status, 403);
  assert.equal((await fetch(`${w.base}/api/events?t=${encodeURIComponent(wide)}`)).status, 403);
  // 그 뒤로도 서버는 멀쩡히 일한다.
  assert.equal((await w.api('/api/state')).status, 200);
});

test('② 토큰이 맞으면 / 는 200 HTML(패널)', async (t) => {
  const w = await world(t);
  const r = await w.api('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer', '주소에 든 토큰이 바깥으로 새지 않게');
  assert.equal(await r.text(), PANEL);

  // 쿼리 토큰으로도 열린다(Face 서랍이 여는 방식).
  const q = await fetch(`${w.base}/?t=${TOKEN}`);
  assert.equal(q.status, 200);
});

test('③ /api/state 는 로그인 전 stage "out" + 화면이 필요한 값을 모두 담는다', async (t) => {
  const w = await world(t);
  const s = await w.state();
  assert.equal(s.stage, 'out');
  assert.equal(s.hubMismatch, null);
  assert.equal(s.keyMismatch, false);
  assert.equal(s.connection, 'stopped');
  assert.deepEqual(s.unread, { total: 0, byPeer: {} });
  assert.deepEqual(s.contacts, []);
  assert.equal(s.notifyMuted, false);
  assert.equal(s.hub.custom, false);
  assert.match(s.hub.url, /^https?:\/\//);
  // 화면이 다른 설정 없이 살아가도록: 테마·판번호·한도·위험 확장자
  assert.equal(s.version, JSON.parse(fssync.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); // 판번호는 package.json 하나에서만
  assert.deepEqual(s.limits, { textMax: TEXT_MAX, fileMax: FILE_MAX });
  assert.ok(new RegExp(s.riskyExt, 'i').test('setup.exe'));
  assert.equal(Object.hasOwn(s, 'theme'), true);
});

test('④ 잘못된 이메일은 400 {error}', async (t) => {
  const w = await world(t);
  const r = await w.json('/api/login/email', { method: 'POST', body: { email: 'nope' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /email/);
  assert.equal((await w.state()).stage, 'out');
});

test('⑤ 이메일 → 코드 123456 → stage "identity"', async (t) => {
  const w = await world(t);
  const ask = await w.json('/api/login/email', { method: 'POST', body: { email: 'me@example.com' } });
  assert.equal(ask.status, 200);
  assert.equal((await w.state()).stage, 'code');

  const bad = await w.json('/api/login/code', { method: 'POST', body: { email: 'me@example.com', code: '000000' } });
  assert.equal(bad.status, 400);
  assert.equal((await w.state()).stage, 'code');

  const ok = await w.json('/api/login/code', { method: 'POST', body: { email: 'me@example.com', code: '123456' } });
  assert.equal(ok.status, 200);
  const s = await w.state();
  assert.equal(s.stage, 'identity');
  assert.equal(s.email, 'me@example.com');
  assert.equal(s.user.id, 'u1');
});

test('⑥ /api/identity 는 12단어를 한 번만 돌려주고 stage "in"이 된다', async (t) => {
  const w = await world(t);
  const r = await signIn(w);
  assert.equal(r.status, 200);
  assert.equal(r.body.words.length, 12);

  const s = await w.state();
  assert.equal(s.stage, 'in');
  assert.equal(s.displayName, '나');
  assert.equal(typeof s.fingerprint, 'string');
  assert.equal(w.fake.profiles.length, 1);
  assert.equal(w.fake.profiles[0].display_name, '나');

  // 백업 문구는 사용자가 확인을 누를 때만 다시 보여 준다.
  const noConfirm = await w.json('/api/identity/words');
  assert.equal(noConfirm.status, 400);
  const again = await w.json('/api/identity/words?confirm=1');
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.words, r.body.words);
});

test('⑦ /api/events 첫 청크는 event: state', async (t) => {
  const w = await world(t);
  const ctrl = new AbortController();
  const res = await fetch(`${w.base}/api/events?t=${TOKEN}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chunk = Buffer.from(value).toString('utf8');
  assert.match(chunk, /^event: state\n/);
  const data = JSON.parse(/data: (.*)\n/.exec(chunk)[1]);
  assert.equal(data.stage, 'out');

  ctrl.abort();
  await reader.cancel().catch(() => {});
});

test('⑧ 10MB + 1바이트 업로드는 413, 상대가 없거나 엉터리면 본문을 읽기 전에 400', async (t) => {
  const w = await world(t);
  await signIn(w); // 편지 기능은 로그인한 계정의 폴더 위에서만 산다
  const peer = crypto.randomUUID();
  const big = Buffer.alloc(FILE_MAX + 1, 0x41);
  const r = await w.api(`/api/send-file?peer=${peer}&name=big.bin`, { method: 'POST', body: big, raw: true });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /too large/);

  const noPeer = await w.json('/api/send-file?name=x.txt', { method: 'POST', body: Buffer.from('짧은 파일'), raw: true });
  assert.equal(noPeer.status, 400);
  assert.match(noPeer.body.error, /peer required/);

  const badPeer = await w.json('/api/send-file?peer=u2&name=x.txt', { method: 'POST', body: Buffer.from('짧은 파일'), raw: true });
  assert.equal(badPeer.status, 400);
  assert.match(badPeer.body.error, /bad peer id/);
});

test('⑨ 모르는 경로는 404 JSON', async (t) => {
  const w = await world(t);
  const r = await w.json('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

test('⑩ /api/settings 로 알림 끄기가 상태에 반영된다', async (t) => {
  const w = await world(t);
  assert.equal((await w.json('/api/settings')).body.notifyMuted, false);

  const r = await w.json('/api/settings', { method: 'POST', body: { notifyMuted: true } });
  assert.equal(r.status, 200);
  assert.equal((await w.state()).notifyMuted, true);
  assert.equal((await w.json('/api/settings')).body.notifyMuted, true);

  // 파일로도 남아 다음 실행에서 이어진다.
  const saved = JSON.parse(fssync.readFileSync(path.join(w.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.notifyMuted, true);
});

test('⑪ 기록 조회·읽음 처리는 상대가 없어도 안전하게 빈 값을 돌려준다(상대 번호는 uuid만)', async (t) => {
  const w = await world(t);
  await signIn(w);
  const peer = crypto.randomUUID();
  const hist = await w.json(`/api/messages/${peer}?limit=10`);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.items, []);

  const read = await w.json('/api/read', { method: 'POST', body: { peer } });
  assert.equal(read.status, 200);
  assert.equal(w.sent.some((o) => o.t === 'badge'), true, '읽음 처리 뒤에는 배지를 다시 알린다');

  // uuid 가 아닌 상대 번호는 본문·기록을 건드리기 전에 400으로 막는다.
  const badHist = await w.json('/api/messages/u2');
  assert.equal(badHist.status, 400);
  assert.equal(badHist.body.error, 'bad peer id');
  const badRead = await w.json('/api/read', { method: 'POST', body: { peer: 'u2' } });
  assert.equal(badRead.status, 400);
  assert.equal(badRead.body.error, 'bad peer id');
});

test('⑫ 로그아웃하면 stage "out"으로 돌아가고 세션 파일이 사라진다', async (t) => {
  const w = await world(t);
  await signIn(w);
  assert.equal(fssync.existsSync(path.join(w.dir, 'auth.bin')), true, '로그인 정보는 뿌리에');

  const r = await w.json('/api/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await w.state()).stage, 'out');
  assert.equal(fssync.existsSync(path.join(w.dir, 'auth.bin')), false);
  assert.equal(fssync.existsSync(w.acct('u1', 'keys.bin')), true, '열쇠는 남는다(같은 계정으로 다시 로그인)');
});

test('⑬ 탈퇴는 내 계정의 것만 지운다(다른 계정 폴더·이 PC의 설정은 그대로)', async (t) => {
  const w = await world(t);
  await signIn(w);
  assert.equal(w.fake.profiles.length, 1);
  assert.equal(fssync.existsSync(w.acct('u1', 'keys.bin')), true);
  await w.json('/api/settings', { method: 'POST', body: { notifyMuted: true } });

  // 같은 PC를 쓰는 다른 계정의 편지 한 통
  fssync.mkdirSync(w.acct('u9', 'messages'), { recursive: true });
  fssync.writeFileSync(w.acct('u9', 'messages', 'x.ndjson'), 'line\n');

  const r = await w.json('/api/delete-account', { method: 'POST' });
  assert.equal(r.status, 200);
  const s = await w.state();
  assert.equal(s.stage, 'out');
  assert.equal(s.displayName, null, '떠난 계정의 표시 이름은 남기지 않는다');
  assert.equal(w.fake.profiles.length, 0);
  assert.equal(fssync.existsSync(path.join(w.dir, 'auth.bin')), false);
  assert.equal(fssync.existsSync(w.acct('u1')), false, '내 계정 폴더는 통째로 사라진다');
  assert.equal(fssync.existsSync(w.acct('u9', 'messages', 'x.ndjson')), true, '다른 계정의 편지는 그대로');
  const saved = JSON.parse(fssync.readFileSync(path.join(w.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.notifyMuted, true, '이 PC의 설정은 그대로');
  assert.equal(saved.displayName, undefined);
});

test('⑭ 허브 스키마가 모듈보다 새로우면 hubMismatch = module_old', async (t) => {
  const w = await world(t);
  w.fake.meta = [{ key: 'schema_version', value: '2' }];
  await signIn(w);
  const s = await w.state();
  assert.equal(s.stage, 'in');
  assert.equal(s.hubMismatch, 'module_old');
  assert.equal(s.connection, 'stopped', '맞지 않는 허브에는 연결하지 않는다');
});

test('⑮ 서버가 아는 열쇠가 내 열쇠와 다르면 stage "identity"로 잠그고, 12단어 복원으로 풀린다', async (t) => {
  const w = await world(t);
  await signIn(w);
  assert.equal((await w.state()).stage, 'in');

  // 다른 기기에서 열쇠를 재설정한 상황: 서버의 공개키가 다른 12단어에서 나온 값으로 바뀌었다.
  const otherWords = entropyToMnemonic(generateEntropy());
  const otherPublic = deriveKeyPair(mnemonicToEntropy(otherWords)).publicRaw;
  w.fake.profiles[0].public_key = b64.enc(otherPublic);
  w.fake.profiles[0].key_version = 2;

  await w.app.init({ stateDir: w.dir }); // 모듈을 다시 시작한 셈
  let s = await w.state();
  assert.equal(s.stage, 'identity', '열지도 못할 열쇠로는 대화 화면에 들어가지 않는다');
  assert.equal(s.keyMismatch, true);
  assert.equal(s.connection, 'stopped', '어긋난 열쇠로는 연결하지 않는다');

  // 맞는 12단어를 넣으면 풀린다(복원은 새 단어를 돌려주지 않는다).
  const r = await w.json('/api/identity', { method: 'POST', body: { displayName: '나', words: otherWords } });
  assert.equal(r.status, 200);
  assert.equal(r.body.words, undefined);
  s = await w.state();
  assert.equal(s.stage, 'in');
  assert.equal(s.keyMismatch, false);
});

test('⑰ /api/identity/rename 은 이름만 바꾼다(열쇠·지문 그대로), 빈 이름·41자는 400', async (t) => {
  const w = await world(t);
  await signIn(w);
  const before = await w.state();

  const r = await w.json('/api/identity/rename', { method: 'POST', body: { displayName: '  새 이름  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayName, '새 이름');

  const after = await w.state();
  assert.equal(after.displayName, '새 이름');
  assert.equal(after.fingerprint, before.fingerprint, '열쇠 지문은 그대로');
  assert.equal(w.fake.profiles[0].display_name, '새 이름', '서버 profiles 도 따라간다');
  assert.equal(w.fake.profiles.length, 1, '행이 새로 생기지 않는다');

  // 다음 실행이 이어받도록 settings.json 에도 남는다.
  const saved = JSON.parse(fssync.readFileSync(path.join(w.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.displayName, '새 이름');

  const empty = await w.json('/api/identity/rename', { method: 'POST', body: { displayName: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'display name required');

  const long = await w.json('/api/identity/rename', { method: 'POST', body: { displayName: '가'.repeat(41) } });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'display name too long');
  assert.equal((await w.state()).displayName, '새 이름', '거절된 요청은 이름을 건드리지 않는다');

  // 40자는 통과한다(경계).
  const edge = await w.json('/api/identity/rename', { method: 'POST', body: { displayName: '나'.repeat(40) } });
  assert.equal(edge.status, 200);
});

test('⑰-2 /api/identity/avatar 는 JPEG data URL 만 받고(≤32KB), null 이면 지우며, 서버 profiles·상태·settings.json 이 같이 움직인다', async (t) => {
  const w = await world(t);
  await signIn(w);
  const pic = 'data:image/jpeg;base64,' + Buffer.from('tiny-jpeg-bytes').toString('base64');

  const ok = await w.json('/api/identity/avatar', { method: 'POST', body: { avatar: pic } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.avatar, pic);
  assert.equal((await w.state()).avatar, pic);
  assert.equal(w.fake.profiles[0].avatar, pic, '서버 profiles 도 따라간다');
  assert.equal(w.fake.profiles.length, 1);
  const saved = JSON.parse(fssync.readFileSync(path.join(w.dir, 'settings.json'), 'utf8'));
  assert.equal(saved.avatar, pic, '다음 실행이 이어받도록 settings.json 에도 남는다(표시 이름과 같은 자리)');

  const png = await w.json('/api/identity/avatar', { method: 'POST', body: { avatar: 'data:image/png;base64,AAAA' } });
  assert.equal(png.status, 400);
  assert.equal(png.body.error, 'bad avatar');
  const big = await w.json('/api/identity/avatar', { method: 'POST', body: { avatar: 'data:image/jpeg;base64,' + 'A'.repeat(33 * 1024) } });
  assert.equal(big.status, 400);
  assert.equal(big.body.error, 'avatar too large');
  assert.equal((await w.state()).avatar, pic, '거절된 요청은 사진을 건드리지 않는다');

  const gone = await w.json('/api/identity/avatar', { method: 'POST', body: { avatar: null } });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.avatar, null);
  assert.equal((await w.state()).avatar, null);
  assert.equal(w.fake.profiles[0].avatar, null);
});

test('⑰-3 /privacy 는 같은 문지기를 지나 처리방침 한 장을 내준다', async (t) => {
  const w = await world(t);
  assert.equal((await fetch(`${w.base}/privacy`)).status, 403, '토큰 없이는 403');
  const r = await fetch(`${w.base}/privacy?t=${TOKEN}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(r.headers.get('content-security-policy'));
  assert.equal(await r.text(), PRIVACY);
});

// ── 검토 지적 반영(fix wave 2, 2026-09-13) ─────────────────────────────────

test('⑱ 계정을 갈아타도 서로의 자료가 섞이지 않는다(계정 폴더 분리)', async (t) => {
  const w = await world(t);
  await signIn(w);                                   // u1 로 로그인 + 열쇠
  const one = await w.state();
  assert.equal(one.stage, 'in');
  assert.equal(fssync.existsSync(w.acct('u1', 'keys.bin')), true, 'u1 의 열쇠는 u1 폴더에');

  // u2 로 갈아타기 — 열쇠도 연락처도 편지도 없는 새 계정이어야 한다.
  await w.json('/api/logout', { method: 'POST' });
  w.fake.userId = 'u2';
  await w.json('/api/login/email', { method: 'POST', body: { email: 'other@example.com' } });
  await w.json('/api/login/code', { method: 'POST', body: { email: 'other@example.com', code: '123456' } });
  let s = await w.state();
  assert.equal(s.user.id, 'u2');
  assert.equal(s.stage, 'identity', '새 계정에는 이 PC의 열쇠가 없다');
  assert.equal(s.fingerprint, null);
  assert.deepEqual(s.contacts, []);
  assert.equal(s.unread.total, 0);

  await w.json('/api/identity', { method: 'POST', body: { displayName: '둘째' } });
  s = await w.state();
  assert.equal(s.stage, 'in');
  assert.notEqual(s.fingerprint, one.fingerprint, '두 계정의 열쇠는 서로 다르다');
  assert.equal(fssync.existsSync(w.acct('u2', 'keys.bin')), true);
  assert.equal(fssync.existsSync(w.acct('u1', 'keys.bin')), true, 'u1 의 열쇠는 지워지지 않았다');

  // 다시 u1 로 — 지우지 않았으니 그대로 돌아온다.
  await w.json('/api/logout', { method: 'POST' });
  w.fake.userId = 'u1';
  await w.json('/api/login/email', { method: 'POST', body: { email: 'me@example.com' } });
  await w.json('/api/login/code', { method: 'POST', body: { email: 'me@example.com', code: '123456' } });
  s = await w.state();
  assert.equal(s.stage, 'in');
  assert.equal(s.fingerprint, one.fingerprint, 'u1 의 열쇠·지문이 그대로 돌아온다');
  assert.equal(s.displayName, '나', '이름은 서버(profiles)가 정본');
});

test('⑲ 0.1.0 폴더(뿌리에 흩어진 파일)는 첫 로그인 때 계정 폴더로 옮겨진다', async (t) => {
  const w = await world(t);
  // 계정 폴더가 생기기 전 판이 남긴 자리: 연락처 1명 + 빈 outbox
  const pin = { displayName: '옛 친구', publicKey: Buffer.alloc(32, 7).toString('base64'), keyVersion: 1, pinnedAt: 1 };
  fssync.writeFileSync(path.join(w.dir, 'contacts.json'), JSON.stringify({ pins: { [crypto.randomUUID()]: pin } }), 'utf8');
  fssync.writeFileSync(path.join(w.dir, 'outbox.json'), '[]', 'utf8');

  await w.json('/api/login/email', { method: 'POST', body: { email: 'me@example.com' } });
  await w.json('/api/login/code', { method: 'POST', body: { email: 'me@example.com', code: '123456' } });

  assert.equal(fssync.existsSync(path.join(w.dir, 'contacts.json')), false, '뿌리에서는 사라지고');
  assert.equal(fssync.existsSync(w.acct('u1', 'contacts.json')), true, '계정 폴더로 옮겨진다');
  assert.equal(fssync.existsSync(w.acct('u1', 'outbox.json')), true);
  const s = await w.state();
  assert.equal(s.contacts.length, 1, '옮긴 연락처가 그대로 보인다');
  assert.equal(s.contacts[0].displayName, '옛 친구');
});

test('⑳ 서버에 프로필만 없으면 stage "identity" + profileMissing, 이 PC 열쇠로 등록하면 풀린다', async (t) => {
  const w = await world(t);
  await signIn(w);
  const before = await w.state();
  assert.equal(before.profileMissing, false);

  w.fake.profiles.length = 0;            // 서버에서 내 프로필 줄만 사라진 상황(탈퇴 뒤 재가입 등)
  await w.app.init({ stateDir: w.dir }); // 모듈을 다시 시작한 셈
  let s = await w.state();
  assert.equal(s.stage, 'identity');
  assert.equal(s.profileMissing, true);
  assert.equal(s.keyMismatch, false, '열쇠가 다른 것이 아니라 서버에 줄이 없는 것');
  assert.equal(s.connection, 'stopped', '프로필이 없으면 연결하지 않는다');

  const r = await w.json('/api/identity/register', { method: 'POST', body: { displayName: '나' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayName, '나');
  s = await w.state();
  assert.equal(s.stage, 'in');
  assert.equal(s.profileMissing, false);
  assert.equal(s.fingerprint, before.fingerprint, '열쇠·지문은 그대로다(상대에게 경고가 가지 않는다)');
  assert.equal(w.fake.profiles.length, 1);
  assert.equal(w.fake.profiles[0].display_name, '나');
  assert.equal(w.fake.profiles[0].key_version, 1);
});

test('⑯ 코드 결함(TypeError)은 속내를 감춘 500, 사용자에게 뜻이 있는 오류는 그대로 400', async (t) => {
  const w = await world(t);
  const real = w.app.state.bind(w.app);
  w.app.state = () => { throw new TypeError('boom'); };
  const broken = await w.json('/api/state');
  w.app.state = real;

  assert.equal(broken.status, 500);
  assert.equal(broken.body.error, 'internal error', '속사정은 화면에 보내지 않는다');
  assert.match(w.logs.join('\n'), /boom/, '까닭은 stderr 로그에 남는다');

  // 사용자에게 뜻이 있는 말은 그대로 보여 준다.
  const plain = await w.json('/api/login/email', { method: 'POST', body: { email: '' } });
  assert.equal(plain.status, 400);
  assert.equal(plain.body.error, 'bad email');
  assert.equal((await w.api('/api/state')).status, 200, '그 뒤로도 서버는 멀쩡하다');
});

// 0.3.3 결함 수정: 켜 둔 사이 상대가 내 초대 코드를 입력하면(서버에 pending 행, 요청한 쪽 = 상대) 시작 때 한 번만 맞추던
// 친구목록에는 영영 뜨지 않았다. 이제 30초마다·화면이 붙을 때 맞추고, 새 "받은 요청"은 contacts 사건(배지·알림)으로 알린다.
test('㉑ 켜 둔 사이 들어온 친구 요청은 주기 맞추기·화면 접속 때 "받은 요청"으로 올라오고 contacts 사건이 난다', async (t) => {
  const timers = fakeTimers();
  let clock = Date.now();
  const w = await world(t, { timers, now: () => clock });
  await signIn(w);
  const me = (await w.state()).user.id;
  assert.deepEqual((await w.state()).contacts, []);
  const iv = timers.pending().filter((x) => x.kind === 'interval' && x.ms === CONTACTS_SYNC_MS);
  assert.equal(iv.length, 1, '사용 가능 단계가 되면 친구목록 시계가 하나 걸린다');

  // 상대가 내 초대 코드를 입력했다 → 서버에 pending 행(요청한 쪽 = 상대). 내 모듈은 아직 모른다.
  const other = crypto.randomUUID();
  const otherPublic = deriveKeyPair(generateEntropy()).publicRaw;
  w.fake.profiles.push({ id: other, display_name: '똥개', public_key: b64.enc(otherPublic), key_version: 1, avatar: null });
  const [a, b] = me < other ? [me, other] : [other, me];
  w.fake.contactRows.push({ user_a: a, user_b: b, status: 'pending', requested_by: other, blocked_by: null });
  const events = [];
  w.app.on((ev) => events.push(ev));

  // 최소 간격 안의 요청은 서버를 두드리지 않는다(화면이 여닫힐 때마다 부르는 경로).
  const selects = w.fake.calls.select;
  assert.deepEqual((await w.json('/api/contacts/sync', { method: 'POST' })).body.contacts, []);
  assert.equal(w.fake.calls.select, selects, '간격 안이면 서버 호출 없음');

  // 30초 뒤 시계가 울리면 서버와 맞춰 "받은 요청"이 올라온다.
  clock += CONTACTS_SYNC_MS;
  await timers.fire(iv[0].id);
  const s = await w.state();
  assert.equal(s.contacts.length, 1);
  assert.equal(s.contacts[0].id, other);
  assert.equal(s.contacts[0].status, 'pending_in');
  assert.equal(s.contacts[0].displayName, '똥개');
  assert.equal(w.app.pendingRequests(), 1, '배지에 더할 받은 요청 수');
  const ev = events.find((e) => e.type === 'contacts');
  assert.deepEqual(ev?.requests, [{ id: other, displayName: '똥개' }], '새 요청만 알림 대상으로 담는다');
  assert.equal(events.some((e) => e.type === 'state'), true, '화면을 다시 그리게 한다');

  // 달라진 것이 없으면 사건도 없다(같은 목록으로 화면을 흔들지 않는다).
  events.length = 0;
  clock += CONTACTS_SYNC_MS;
  await timers.fire(iv[0].id);
  assert.deepEqual(events, []);

  // 화면이 붙으면(SSE) 한 번 더 맞춘다 — 그 사이 상대 쪽 사정으로 요청이 사라졌다면 목록에서도 빠진다.
  w.fake.contactRows.length = 0;
  clock += CONTACTS_SYNC_GAP_MS;
  const ctrl = new AbortController();
  const res = await fetch(`${w.base}/api/events?t=${TOKEN}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // 첫 청크 = 붙기 전 상태
  for (let i = 0; i < 50 && w.app.pendingRequests() !== 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.app.pendingRequests(), 0, '화면 접속이 맞추기를 한 번 더 부른다');
  assert.deepEqual((await w.state()).contacts, []);
  ctrl.abort();
  await reader.cancel().catch(() => {});

  // 로그아웃하면 시계를 거둔다.
  await w.json('/api/logout', { method: 'POST' });
  assert.equal(timers.pending().filter((x) => x.kind === 'interval' && x.ms === CONTACTS_SYNC_MS).length, 0);
});
