// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// Face 계약 v1 모듈 프로세스. stdin으로 hello·shutdown만 받고, stdout으로 panel·badge·notify만 보낸다.
// 편지 내용·토큰·열쇠는 stdout에 절대 쓰지 않는다(본체는 메시지를 모른다).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { App } from './app.mjs';
import { createHandler } from './api.mjs';
import { loadPanel } from './panel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = '<!doctype html><meta charset="utf-8"><title>IRIS Messenger</title><p>panel pending</p>';
const NOTIFY_GAP = 60000; // 같은 상대에게는 1분에 한 번만 알린다
const EXIT_GRACE = 1500;  // 계약: shutdown 뒤 2초 안에 끝난다

const token = crypto.randomBytes(8).toString('hex');
const out = (o) => { try { process.stdout.write(`${JSON.stringify(o)}\n`); } catch { /* 본체가 이미 갔다 */ } };
const logErr = (m) => { try { process.stderr.write(`[messenger] ${m}\n`); } catch { /* noop */ } };

let panelHtml = PLACEHOLDER;
let privacyHtml = PLACEHOLDER;
try { privacyHtml = fs.readFileSync(path.join(HERE, 'privacy.html'), 'utf8'); } catch (e) { logErr(`privacy: ${e?.message || e}`); }
try { panelHtml = loadPanel(HERE); } catch (e) { logErr(`panel: ${e?.message || e}`); /* 화면 파일이 없으면 자리만 지킨다 */ }

const app = new App({ log: logErr });
let server = null;
let panelSent = false;
let helloSeen = false;
let closing = false;
const lastNotify = new Map();

const badgeCount = () => {
  try { return Math.max(0, Math.min(999, app.messages?.unread().total ?? 0)); } catch { return 0; }
};

// 편지 사건 → 배지·알림. 알림에는 보낸 이 이름만 담고 본문은 절대 담지 않는다.
app.on((ev) => {
  if (!panelSent) return; // panel보다 먼저 말하지 않는다(첫 줄은 언제나 panel)
  try {
    if (ev.type === 'message' || ev.type === 'badge') out({ t: 'badge', count: badgeCount() });
    if (ev.type !== 'message') return;
    const item = ev.item;
    if (!item || item.dir !== 'in' || item.status === 'failed') return;
    if (app.notifyMuted) return; // 설정만 본다 — 편지 한 통마다 state()를 통째로 만들지 않는다
    const peer = String(ev.peer ?? '');
    const now = Date.now();
    if (now - (lastNotify.get(peer) || 0) < NOTIFY_GAP) return;
    for (const [id, at] of lastNotify) if (now - at >= NOTIFY_GAP) lastNotify.delete(id); // 오래된 자국은 버린다
    lastNotify.set(peer, now);
    const name = app.contacts?.get(peer)?.displayName || '연락처';
    out({ t: 'notify', title: String(name).slice(0, 80), sub: '새 메시지', target: peer.slice(0, 120) });
  } catch (e) {
    logErr(`event: ${e.message}`);
  }
});

async function onHello(m) {
  if (helloSeen) { logErr('dropped: hello twice'); return; }
  helloSeen = true;
  app.setHello({ theme: m.theme, lang: m.lang, face: m.face });
  const stateDir = m.stateDir || process.env.IRIS_MODULE_STATE || path.join(HERE, 'state');
  try {
    await app.init({ stateDir });
  } catch (e) {
    logErr(`init: ${e.stack || e.message}`); // 초기화에 실패해도 화면은 띄워 사용자가 까닭을 본다
  }
  server = http.createServer(createHandler({ app, token, panelHtml, privacyHtml, out, log: logErr }));
  server.on('clientError', (err, socket) => { logErr(`client: ${err.message}`); try { socket.destroy(); } catch { /* noop */ } });
  server.on('error', (err) => logErr(`server: ${err.message}`));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  out({ t: 'panel', url: `http://127.0.0.1:${server.address().port}/?t=${token}` });
  panelSent = true;
  out({ t: 'badge', count: badgeCount() });
}

function shutdown() {
  if (closing) return;
  closing = true;
  const bail = setTimeout(() => process.exit(0), EXIT_GRACE);
  bail.unref?.();
  Promise.resolve(app.shutdown())
    .catch((e) => logErr(`shutdown: ${e.message}`))
    .finally(() => {
      try { server?.closeAllConnections?.(); } catch { /* 옛 Node */ }
      try { server?.close(); } catch { /* 이미 닫힘 */ }
      process.exit(0);
    });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let m;
  try { m = JSON.parse(text); } catch { logErr('dropped: not json'); return; }
  if (m?.t === 'hello') { onHello(m).catch((e) => logErr(`hello: ${e.stack || e.message}`)); return; }
  if (m?.t === 'shutdown') { shutdown(); return; }
  logErr(`dropped: ${String(m?.t ?? 'unknown').slice(0, 40)}`);
});
rl.on('close', () => shutdown()); // 본체가 전선을 놓으면 따라 끝낸다

// 죽지 않는다 — 까닭만 stderr(코어 로그)에 남긴다.
process.on('uncaughtException', (e) => logErr(`uncaught: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => logErr(`unhandled: ${e?.stack || e}`));
