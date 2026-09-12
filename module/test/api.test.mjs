// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 로컬 HTTP/SSE 화면 API 시험: 토큰 문지기 · 상태 기계(out→code→identity→in) · SSE · 업로드 상한 · 설정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dpapiPlain } from '../../hub/client/dpapi.mjs';
import { FILE_MAX, TEXT_MAX } from '../messages.mjs';
import { App } from '../app.mjs';
import { createHandler } from '../api.mjs';
import { FakeSupa } from './_fakesupa.mjs';

const PANEL = '<!doctype html><meta charset="utf-8"><title>IRIS Messenger</title><p>panel pending</p>';
const TOKEN = 'deadbeefcafe0123';

// App(가짜 허브·가짜 DPAPI) + createHandler를 실제 http 서버에 붙인 한 벌.
async function world(t) {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-api-'));
  const fake = new FakeSupa();
  const app = new App({ makeSupa: () => fake, dpapi: dpapiPlain, log: () => {} });
  await app.init({ stateDir: dir });
  const sent = [];
  const server = http.createServer(createHandler({ app, token: TOKEN, panelHtml: PANEL, out: (o) => sent.push(o) }));
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

  return { dir, fake, app, base, api, json, state, sent };
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
});

test('② 토큰이 맞으면 / 는 200 HTML(패널)', async (t) => {
  const w = await world(t);
  const r = await w.api('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
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
  assert.equal(s.connection, 'stopped');
  assert.deepEqual(s.unread, { total: 0, byPeer: {} });
  assert.deepEqual(s.contacts, []);
  assert.equal(s.notifyMuted, false);
  assert.equal(s.hub.custom, false);
  assert.match(s.hub.url, /^https?:\/\//);
  // 화면이 다른 설정 없이 살아가도록: 테마·판번호·한도·위험 확장자
  assert.equal(s.version, '0.1.0');
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

test('⑧ 10MB + 1바이트 업로드는 413', async (t) => {
  const w = await world(t);
  const big = Buffer.alloc(FILE_MAX + 1, 0x41);
  const r = await w.api('/api/send-file?peer=u2&name=big.bin', { method: 'POST', body: big, raw: true });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /too large/);
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

test('⑪ 기록 조회·읽음 처리는 상대가 없어도 안전하게 빈 값을 돌려준다', async (t) => {
  const w = await world(t);
  await signIn(w);
  const hist = await w.json('/api/messages/u2?limit=10');
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.items, []);

  const read = await w.json('/api/read', { method: 'POST', body: { peer: 'u2' } });
  assert.equal(read.status, 200);
  assert.equal(w.sent.some((o) => o.t === 'badge'), true, '읽음 처리 뒤에는 배지를 다시 알린다');
});

test('⑫ 로그아웃하면 stage "out"으로 돌아가고 세션 파일이 사라진다', async (t) => {
  const w = await world(t);
  await signIn(w);
  assert.equal(fssync.existsSync(path.join(w.dir, 'auth.bin')), true);

  const r = await w.json('/api/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await w.state()).stage, 'out');
  assert.equal(fssync.existsSync(path.join(w.dir, 'auth.bin')), false);
  assert.equal(fssync.existsSync(path.join(w.dir, 'keys.bin')), true, '열쇠는 남는다(같은 계정으로 다시 로그인)');
});

test('⑬ 탈퇴하면 서버 행과 로컬 흔적이 모두 사라지고 stage "out"으로 돌아간다', async (t) => {
  const w = await world(t);
  await signIn(w);
  assert.equal(w.fake.profiles.length, 1);

  const r = await w.json('/api/delete-account', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await w.state()).stage, 'out');
  assert.equal(w.fake.profiles.length, 0);
  assert.equal(fssync.existsSync(path.join(w.dir, 'auth.bin')), false);
  assert.equal(fssync.existsSync(path.join(w.dir, 'keys.bin')), false);
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
