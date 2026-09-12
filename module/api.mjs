// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 127.0.0.1 전용 화면 API. 모든 요청은 1회용 토큰(?t= 또는 x-token)을 지녀야 하며, 없으면 403.
// 화면(panel.html)이 쓰는 유일한 창구다 — 여기서 App의 메서드만 부른다.
import crypto from 'node:crypto';
import { FILE_MAX } from './messages.mjs';

const JSON_MAX = 1024 * 1024; // 본문 1MB 상한
const CONTACT_ACTIONS = new Set(['accept', 'reject', 'block', 'unblock', 'remove', 'trust-key']);
const PEER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // 허브의 사용자 번호 = uuid
// 우리 잘못(코드 결함)과 사용자에게 보여 줄 말(잘못된 코드·잠김 등)을 가른다.
const BUG_TYPES = [TypeError, RangeError, ReferenceError, SyntaxError];

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj ?? null), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function tooLarge(limit) {
  return Object.assign(new Error(`body too large (max ${limit})`), { httpStatus: 413 });
}

function badRequest(msg) {
  return Object.assign(new Error(msg), { httpStatus: 400 });
}

// 같은 바이트 수·같은 값일 때만 통과(비교 시간으로 토큰을 더듬는 것을 막는다).
// 글자 수가 아니라 **바이트 수**로 재야 한다 — 한글처럼 여러 바이트인 글자가 오면
// timingSafeEqual이 RangeError를 던지기 때문이다.
function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(token ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// 상한을 넘으면 남은 바이트는 버리며 끝까지 받아 준다(연결을 끊지 않아야 상대가 413을 읽는다).
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = Number(req.headers['content-length'] || 0) > limit;
    req.on('data', (c) => {
      size += c.length;
      if (over) return;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(tooLarge(limit)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, JSON_MAX);
  if (!buf.length) return {};
  try {
    const obj = JSON.parse(buf.toString('utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    throw badRequest('bad json');
  }
}

const defaultLog = (m) => { try { process.stderr.write(`[messenger] ${m}\n`); } catch { /* noop */ } };

export function createHandler({ app, token, panelHtml = '', out = () => {}, log = defaultLog }) {
  const need = (thing) => { if (!thing) throw badRequest('hub not configured'); return thing; };

  // 오류 → 응답. 사용자에게 뜻이 있는 말(SupaError·우리가 던진 Error)은 그대로 400으로 보여 주고,
  // 코드 결함(TypeError 등)은 속내를 감춘 500으로 돌려주되 까닭은 stderr에 남긴다.
  function fail(req, res, e) {
    const bug = BUG_TYPES.some((T) => e instanceof T);
    if (bug) log(`internal: ${e?.stack || e}`);
    const status = e?.httpStatus || (bug ? 500 : (Number(e?.status) >= 500 ? 500 : 400));
    try { req.resume(); } catch { /* 이미 끝난 요청 */ }
    if (res.headersSent) { try { res.end(); } catch { /* 이미 끝난 응답 */ } return; }
    sendJson(res, status, { error: bug ? 'internal error' : (e?.message || String(e)) });
  }

  async function route(req, res, u) {
    const p = u.pathname.replace(/\/+$/, '') || '/';
    const seg = p.split('/').filter(Boolean); // ['api','messages','<peer>']
    const method = req.method;

    if (method === 'GET' && p === '/') {
      const body = Buffer.from(panelHtml, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', // 주소에 든 토큰이 바깥으로 새지 않게
      });
      return res.end(body);
    }

    if (seg[0] !== 'api') return sendJson(res, 404, { error: `no route for ${method} ${p}` });

    if (method === 'GET' && p === '/api/state') return sendJson(res, 200, app.state());

    if (method === 'GET' && p === '/api/events') return events(req, res);

    // ---- 로그인 ----
    if (method === 'POST' && p === '/api/login/email') {
      const { email } = await readJsonBody(req);
      return sendJson(res, 200, await app.login1(email));
    }
    if (method === 'POST' && p === '/api/login/code') {
      const { email, code } = await readJsonBody(req);
      return sendJson(res, 200, await app.login2(email, code));
    }
    if (method === 'POST' && p === '/api/logout') return sendJson(res, 200, await app.logout());
    if (method === 'POST' && p === '/api/delete-account') return sendJson(res, 200, await app.deleteAccount());

    // ---- 신원(열쇠) ----
    if (method === 'POST' && p === '/api/identity') {
      const { displayName, words } = await readJsonBody(req);
      return sendJson(res, 200, await app.setupIdentity({ displayName, words }));
    }
    if (method === 'GET' && p === '/api/identity/words') {
      if (u.searchParams.get('confirm') !== '1') throw badRequest('confirm=1 required');
      return sendJson(res, 200, await app.mnemonic());
    }
    if (method === 'POST' && p === '/api/identity/reset') {
      const { displayName } = await readJsonBody(req);
      return sendJson(res, 200, await app.resetIdentity({ displayName }));
    }
    if (method === 'POST' && p === '/api/identity/rename') {
      const { displayName } = await readJsonBody(req);
      return sendJson(res, 200, await app.rename(displayName));
    }

    // ---- 편지 ----
    if (method === 'GET' && seg[1] === 'messages' && seg.length === 3) {
      const peer = decodeURIComponent(seg[2]);
      const limit = Number(u.searchParams.get('limit')) || undefined;
      return sendJson(res, 200, { peer, items: need(app.messages).history(peer, limit ? { limit } : {}) });
    }
    if (method === 'POST' && p === '/api/send') {
      const { peer, text } = await readJsonBody(req);
      if (!peer) throw badRequest('peer required');
      return sendJson(res, 200, { item: await need(app.messages).sendText(peer, text) });
    }
    if (method === 'POST' && p === '/api/send-file') {
      // 상대를 먼저 본다 — 10MB를 다 받은 뒤에 "상대가 없다"고 하지 않도록.
      const peer = u.searchParams.get('peer');
      if (!peer) throw badRequest('peer required');
      if (!PEER_RE.test(peer)) throw badRequest('bad peer id');
      const name = u.searchParams.get('name') || 'file';
      need(app.messages);
      const data = await readBody(req, FILE_MAX); // 상한을 넘으면 413
      return sendJson(res, 200, { item: await app.messages.sendFile(peer, { name, data }) });
    }
    if (method === 'POST' && p === '/api/read') {
      const { peer } = await readJsonBody(req);
      if (!peer) throw badRequest('peer required');
      await need(app.messages).markRead(peer);
      const count = app.messages.unread().total;
      out({ t: 'badge', count });
      return sendJson(res, 200, { unread: app.messages.unread() });
    }
    if (method === 'POST' && seg[1] === 'file' && seg.length === 3) {
      const saved = await need(app.messages).fetchFile(decodeURIComponent(seg[2]));
      return sendJson(res, 200, { path: saved });
    }

    // ---- 연락처 ----
    if (method === 'POST' && p === '/api/invite') {
      return sendJson(res, 200, { code: await need(app.contacts).createInvite() });
    }
    if (method === 'POST' && p === '/api/invite/accept') {
      const { code } = await readJsonBody(req);
      const r = await need(app.contacts).acceptInvite(code);
      app.emitState();
      return sendJson(res, 200, r);
    }
    if (method === 'POST' && p === '/api/contacts/sync') {
      const list = await need(app.contacts).sync();
      app.emitState();
      return sendJson(res, 200, { contacts: list });
    }
    if (method === 'POST' && seg[1] === 'contacts' && seg.length === 4) {
      const id = decodeURIComponent(seg[2]);
      const action = seg[3];
      if (!CONTACT_ACTIONS.has(action)) throw badRequest(`unknown action: ${action}`);
      const contacts = need(app.contacts);
      if (action === 'trust-key') contacts.acceptKeyChange(id);
      else await contacts.respond(id, action);
      app.emitState();
      return sendJson(res, 200, { contacts: contacts.list() });
    }

    // ---- 설정 ----
    if (method === 'GET' && p === '/api/settings') return sendJson(res, 200, app.settingsView());
    if (method === 'POST' && p === '/api/settings') {
      const body = await readJsonBody(req);
      if (body.notifyMuted !== undefined) await app.setNotifyMuted(body.notifyMuted);
      if (body.hubUrl !== undefined || body.anonKey !== undefined) await app.setHub({ url: body.hubUrl, anonKey: body.anonKey });
      return sendJson(res, 200, app.settingsView());
    }

    return sendJson(res, 404, { error: `no route for ${method} ${p}` });
  }

  // 서버가 보내는 사건 흐름(SSE): `event: <종류>` + `data: <json>`, 15초마다 살아 있음 표시.
  function events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 이미 닫힌 화면 */ } };
    write('state', app.state());
    const off = app.on((ev) => write(ev.type, ev.type === 'state' ? app.state() : ev));
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 닫힘 */ } }, 15000);
    ping.unref?.();
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(ping); off(); };
    req.on('close', finish);
    res.on('close', finish);
  }

  // 주소 풀이·토큰 검사·길 처리를 한 울타리 안에 둔다 — 무엇이 터지든 응답 하나로 끝나고,
  // 잡히지 않은 예외로 연결이 매달리는 일이 없다.
  return function handler(req, res) {
    Promise.resolve()
      .then(() => {
        let u;
        try { u = new URL(req.url, 'http://127.0.0.1'); } catch { throw badRequest('bad url'); }
        const header = req.headers['x-token'];
        const given = u.searchParams.get('t') ?? (typeof header === 'string' ? header : null);
        if (!sameToken(given, token)) {
          req.resume(); // 본문을 흘려보내야 상대가 응답을 읽는다
          return sendJson(res, 403, { error: 'forbidden' });
        }
        return route(req, res, u);
      })
      .catch((e) => fail(req, res, e));
  };
}
