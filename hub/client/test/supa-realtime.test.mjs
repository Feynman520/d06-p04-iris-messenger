// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// Supa.subscribe(도어벨) 단위 시험: 가짜 WebSocket으로 주소·join 프레임·이벤트·토큰 갱신·닫기를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supa } from '../supa.mjs';

const HUB = 'https://hub.example.com';
const ANON = 'anon+key/1';

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closeCount = 0;
    FakeWS.last = this;
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closeCount += 1; this.readyState = 3; }
  // --- 테스트가 소켓 쪽 사건을 일으키는 손잡이 ---
  fireOpen() { this.readyState = 1; this.onopen?.(); }
  fireMessage(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  fireClose() { this.readyState = 3; this.onclose?.(); }
}

function setup({ table = 'messages', filter = 'recipient=eq.u1', token = 'at1' } = {}) {
  const supa = new Supa({ url: HUB, anonKey: ANON, WebSocketImpl: FakeWS });
  supa.setSession({ access_token: token, refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  const seen = { changes: [], status: [] };
  const sub = supa.subscribe({ table, filter, onChange: (r) => seen.changes.push(r), onStatus: (s) => seen.status.push(s) });
  return { supa, sub, seen, ws: FakeWS.last };
}

test('① realtime url: wss + /realtime/v1/websocket?apikey=<anon>&vsn=1.0.0', (t) => {
  const { sub, ws } = setup();
  t.after(() => sub.close());
  assert.ok(ws.url.startsWith('wss://hub.example.com/'), `got ${ws.url}`);
  assert.ok(ws.url.endsWith(`/realtime/v1/websocket?apikey=${encodeURIComponent(ANON)}&vsn=1.0.0`), `got ${ws.url}`);
});

test('② first frame is phx_join on realtime:inbox with postgres_changes config + access token', (t) => {
  const { sub, ws, seen } = setup();
  t.after(() => sub.close());
  assert.deepEqual(ws.sent, []); // 열리기 전에는 아무것도 보내지 않는다
  ws.fireOpen();
  const join = ws.sent[0];
  assert.equal(join.topic, 'realtime:inbox');
  assert.equal(join.event, 'phx_join');
  assert.deepEqual(join.payload.config.postgres_changes, [{ event: 'INSERT', schema: 'public', table: 'messages', filter: 'recipient=eq.u1' }]);
  assert.equal(join.payload.access_token, 'at1');
  assert.ok(join.ref, 'every frame carries a ref');
  assert.deepEqual(seen.status, ['open']);
});

test('③ postgres_changes frame delivers payload.data.record to onChange', (t) => {
  const { sub, ws, seen } = setup();
  t.after(() => sub.close());
  ws.fireOpen();
  const record = { id: 'r1', client_id: 'c1', sender: 'u2', body: 'sealed' };
  ws.fireMessage({ event: 'postgres_changes', payload: { data: { record } } });
  assert.deepEqual(seen.changes, [record]);
  ws.fireMessage({ event: 'presence_state', payload: {} }); // 모르는 이벤트는 무시
  assert.equal(seen.changes.length, 1);
});

test('④ phx_reply with status error → onStatus("error")', (t) => {
  const { sub, ws, seen } = setup();
  t.after(() => sub.close());
  ws.fireOpen();
  ws.fireMessage({ event: 'phx_reply', payload: { status: 'ok', response: {} } });
  assert.deepEqual(seen.status, ['open']);
  ws.fireMessage({ event: 'phx_reply', payload: { status: 'error', response: { reason: 'unauthorized' } } });
  assert.deepEqual(seen.status, ['open', 'error']);
});

test('⑤ setSession while open sends an access_token frame', (t) => {
  const { supa, sub, ws } = setup();
  t.after(() => sub.close());
  ws.fireOpen();
  supa.setSession({ access_token: 'at2', refresh_token: 'rt2', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  const frame = ws.sent[ws.sent.length - 1];
  assert.equal(frame.event, 'access_token');
  assert.equal(frame.topic, 'realtime:inbox');
  assert.equal(frame.payload.access_token, 'at2');
});

test('⑥ close() closes the socket and stays quiet; a socket-side close reports "closed" once', () => {
  // (가) 우리가 닫으면 onStatus('closed')는 오지 않는다
  const mine = setup();
  mine.ws.fireOpen();
  mine.sub.close();
  assert.equal(mine.ws.closeCount, 1);
  mine.ws.fireClose();
  mine.sub.close();
  assert.deepEqual(mine.seen.status, ['open']);

  // (나) 소켓이 스스로 끊기면 'closed' 한 번, 그 뒤 close()를 불러도 더 오지 않는다
  const theirs = setup();
  theirs.ws.fireOpen();
  theirs.ws.fireClose();
  theirs.ws.fireClose();
  theirs.sub.close();
  assert.deepEqual(theirs.seen.status, ['open', 'closed']);

  // 세션 청취자도 정리된다: 닫힌 뒤 setSession은 프레임을 더 보내지 않는다
  const before = theirs.ws.sent.length;
  theirs.supa.setSession({ access_token: 'at3', refresh_token: 'rt3', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  assert.equal(theirs.ws.sent.length, before);
});
