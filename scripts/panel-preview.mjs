// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 화면만 보기: 가짜 App(허브·열쇠·네트워크 없음) + 진짜 api.mjs + 진짜 panel.html.
// 연락처 2명·편지 여섯 통을 미리 담아 띄우고 주소를 찍는다. Ctrl+C(또는 stdin 끊김)로 끝난다.
//   node scripts/panel-preview.mjs            → stage 'in'(본 화면)
//   node scripts/panel-preview.mjs --stage=out → 로그인 화면
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../module/api.mjs';
import { loadPanel } from '../module/panel.mjs';
import { TEXT_MAX, FILE_MAX, RISKY_EXT } from '../module/messages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const STAGE = arg('stage', 'in');
const MODE = arg('mode', 'dark') === 'light' ? 'light' : 'dark';   // --mode=light → 밝은 테마로 본다
const PEER1 = '11111111-1111-4111-8111-111111111111';
const PEER2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-09-13T09:41:00.000Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

// 화면만 보여 주기 위한 가짜 자료다 — 이름·내용은 전부 지어낸 것이며 실제 사람과 무관하다.
const CONTACTS = [
  { id: PEER1, displayName: '홍길동', fingerprint: 'K7QD4M2X', status: 'accepted', publicKey: 'pk1', keyVersion: 1, keyChanged: false, needsVerify: false, requestedByMe: false },
  { id: PEER2, displayName: '김철수', fingerprint: 'T9BW3H6R', status: 'pending_in', publicKey: 'pk2', keyVersion: 1, keyChanged: false, needsVerify: false, requestedByMe: false },
];

const HISTORY = {
  [PEER1]: [
    { id: 'm1', peer: PEER1, dir: 'in', kind: 'text', at: at(0), status: 'received', read: true, text: '안녕하세요! 어제 말씀하신 자료 지금 보내 주실 수 있을까요?' },
    { id: 'm2', peer: PEER1, dir: 'out', kind: 'text', at: at(2), status: 'sent', read: true, text: '네, 바로 보내 드릴게요. 2쪽 표만 어제 고쳤습니다.' },
    { id: 'm3', peer: PEER1, dir: 'out', kind: 'file', at: at(4), status: 'sent', read: true, file: { name: '자료.pdf', size: 862_112, storagePath: 'demo/1' } },
    { id: 'm4', peer: PEER1, dir: 'in', kind: 'text', at: at(5), status: 'received', read: true, text: '받았습니다. 표 잘 보입니다. 사진도 한 장 보냅니다.' },
    { id: 'm5', peer: PEER1, dir: 'in', kind: 'file', at: at(6), status: 'received', read: true, file: { name: '사진.jpg', size: 1_284_310, storagePath: 'demo/2' } },
    { id: 'm6', peer: PEER1, dir: 'out', kind: 'text', at: at(8), status: 'pending', read: true, text: '고맙습니다. 확인하고 회신드릴게요.' },
  ],
  [PEER2]: [
    { id: 'n1', peer: PEER2, dir: 'in', kind: 'text', at: at(1), status: 'received', read: false, text: '초대 코드 보냈습니다. 확인 부탁드립니다.' },
    { id: 'n2', peer: PEER2, dir: 'in', kind: 'text', at: at(3), status: 'received', read: false, text: '수락해 주시면 자료 보내 드릴게요.' },
  ],
};

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];

// api.mjs가 부르는 것만 갖춘 가짜 App. 파일·네트워크·열쇠를 하나도 만지지 않는다.
class FakeApp {
  #listeners = [];

  constructor() {
    this.stage = STAGE;
    this.history = JSON.parse(JSON.stringify(HISTORY));
    this.notifyMuted = false;
    this.contacts = {
      list: () => CONTACTS,
      get: (id) => CONTACTS.find((c) => c.id === id) || null,
      createInvite: async () => 'IRIS-K7QD-4M2X-A3TV',
      acceptInvite: async () => ({ id: PEER2, displayName: '김철수', fingerprint: 'T9BW3H6R' }),
      sync: async () => CONTACTS,
      respond: async () => CONTACTS,
      acceptKeyChange: () => {},
    };
    this.messages = {
      history: (peer) => this.history[peer] || [],
      unread: () => this.#unread(),
      markRead: async (peer) => { for (const i of this.history[peer] || []) i.read = true; },
      sendText: async (peer, text) => this.#add(peer, { kind: 'text', text }),
      sendFile: async (peer, { name, data }) => this.#add(peer, { kind: 'file', file: { name, size: data.length, storagePath: 'demo/new' } }),
      fetchFile: async (id) => {
        for (const list of Object.values(this.history)) {
          const it = list.find((x) => x.id === id);
          if (it) return path.join(ROOT, 'state', 'files', it.file.name);
        }
        throw new Error('no such file');
      },
      connection: 'online',
      stop: () => {},
    };
  }

  #unread() {
    const byPeer = {};
    let total = 0;
    for (const [p, list] of Object.entries(this.history)) {
      const n = list.filter((i) => i.dir === 'in' && !i.read).length;
      if (n) { byPeer[p] = n; total += n; }
    }
    return { total, byPeer };
  }

  #add(peer, base) {
    const item = { id: crypto.randomUUID(), peer, dir: 'out', at: new Date().toISOString(), status: 'sent', read: true, ...base };
    (this.history[peer] ||= []).push(item);
    this.#fan({ type: 'message', peer, item });
    return item;
  }

  on(fn) {
    this.#listeners.push(fn);
    return () => { this.#listeners = this.#listeners.filter((x) => x !== fn); };
  }

  #fan(ev) { for (const fn of this.#listeners) { try { fn(ev); } catch { /* 미리보기라 조용히 */ } } }

  emitState() { this.#fan({ type: 'state' }); }

  state() {
    return {
      stage: this.stage,
      email: this.stage === 'out' ? null : 'me@example.com',
      user: this.stage === 'out' || this.stage === 'code' ? null : { id: 'me' },
      displayName: '이영희',
      fingerprint: 'A3TV8N5P',
      hub: { url: 'https://demo1234.supabase.co', custom: false },
      hubMismatch: null,
      keyMismatch: false,
      profileMissing: false,
      connection: 'online',
      unread: this.#unread(),
      contacts: CONTACTS,
      notifyMuted: this.notifyMuted,
      theme: { id: 'indigo', mode: MODE },
      lang: 'ko',
      version: '0.2.0',
      limits: { textMax: TEXT_MAX, fileMax: FILE_MAX },
      riskyExt: RISKY_EXT.source,
    };
  }

  async login1() { this.stage = 'code'; this.emitState(); return { stage: this.stage }; }
  async login2() { this.stage = 'in'; this.emitState(); return { stage: this.stage }; }
  async logout() { this.stage = 'out'; this.emitState(); return { stage: this.stage }; }
  async deleteAccount() { this.stage = 'out'; this.emitState(); return { stage: this.stage }; }
  async setupIdentity() { this.stage = 'in'; this.emitState(); return { words: WORDS }; }
  async registerExisting(displayName) { this.stage = 'in'; this.emitState(); return { displayName: displayName }; }
  async mnemonic() { return { words: WORDS }; }
  async resetIdentity() { return { words: WORDS }; }
  async setNotifyMuted(v) { this.notifyMuted = !!v; this.emitState(); return this.notifyMuted; }
  async setHub() { this.stage = 'out'; this.emitState(); return { stage: this.stage }; }
  settingsView() { return { notifyMuted: this.notifyMuted, hub: { url: 'https://demo1234.supabase.co', custom: false } }; }
  async shutdown() { this.#listeners = []; }
}

const token = crypto.randomBytes(8).toString('hex');
const panelHtml = loadPanel(path.join(ROOT, 'module'));
const app = new FakeApp();
const server = http.createServer(createHandler({ app, token, panelHtml, out: () => {} }));

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`panel: http://127.0.0.1:${server.address().port}/?t=${token}\n`);
  process.stdout.write(`stage: ${STAGE}\n`);
});

let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
