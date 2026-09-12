// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 편지 흐름: 보내기(봉투→INSERT, 실패 시 outbox) · 받기(도어벨+빈틈 메우기→복호화→ndjson) · 파일 · 연결 상태. 서버에는 암호문만.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { seal, open, sealFile, openFile } from '../hub/client/crypto.mjs';
import { readJson, writeJson, readLines, ensureDir, writeFileAtomic } from '../hub/client/store.mjs';

export const TEXT_MAX = 4000;
export const FILE_MAX = 10 * 1024 * 1024;
// 실행 파일 계열: 화면에서 빨간 경고를 띄우는 데 쓴다(차단이 아니라 경고).
export const RISKY_EXT = /\.(exe|bat|cmd|ps1|js|mjs|vbs|msi|scr|com|pif|reg|hta|jar|lnk|dll)$/i;

const MAX_BATCH = 200;
const BACKOFF_MIN = 1000, BACKOFF_MAX = 60000, POLL_MS = 60000, WS_RETRY_MS = 600000;

// 파일 이름에서 경로·제어문자를 걷어낸다(상대가 보낸 이름을 그대로 믿지 않는다).
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'file';
// 상대 번호를 파일 이름으로 쓸 때의 보호막(서버 id는 uuid라 그대로 통과한다).
const safePeer = (p) => String(p || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';
// 봉투 안의 파일 위치는 보낸 이가 쓴 값이다 — `<보낸 이 번호>/<uuid>` 한 모양만 받는다.
// (Storage 정책상 남의 칸을 가리키는 주소를 우리가 대신 읽어 주는 일을 막는다.)
const UUID_RE = /^[0-9a-f-]{36}$/;
const okStoragePath = (owner, p) => typeof p === 'string' && !!owner && p.startsWith(`${owner}/`) && UUID_RE.test(p.slice(String(owner).length + 1));
const SEAL_OVERHEAD = 12 + 16; // 논스 + GCM 태그

export class Messages {
  #items = new Map();   // peer → item[]
  #outbox = [];         // [{ id, peer, row }]
  #sub = null;
  #stopped = true;
  #fails = 0;
  #backoff = BACKOFF_MIN;
  #poll = null;
  #retryWs = null;
  #conn = 'stopped';
  #bgJobs = new Set();
  #queues = new Map(); // 이름 → 직렬화 사슬

  constructor(o) {
    Object.assign(this, {
      onEvent: () => {},
      log: () => {},
      now: () => Date.now(),
      timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    }, o);
    this.dir = path.join(this.stateDir, 'messages');
    this.filesDir = path.join(this.stateDir, 'files');
  }

  #me() { return typeof this.me === 'function' ? this.me() : this.me; }

  // 배경에서 도는 일(도어벨·폴링·재연결)을 추적해 둔다 — 시험과 종료가 기다릴 수 있게.
  #bg(p) {
    const q = Promise.resolve(p).catch((e) => this.log(`background: ${e.message}`));
    this.#bgJobs.add(q);
    q.finally(() => this.#bgJobs.delete(q));
    return q;
  }

  // 배경 작업이 모두 끝날 때까지 기다린다(작업이 또 작업을 낳는 경우까지).
  async settle() {
    while (this.#bgJobs.size) await Promise.all([...this.#bgJobs]);
  }

  // 같은 이름의 일은 한 번에 하나씩만 돈다(도어벨과 폴링이 겹쳐 같은 편지를 두 번 저장하는 일 방지).
  #serial(name, fn) {
    const prev = this.#queues.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.#queues.set(name, run.then(() => {}, () => {}));
    return run;
  }

  get connection() { return this.#conn; }

  // 화면 콜백이 터져도 편지 흐름은 멈추지 않는다(기록은 이미 디스크에 남긴 뒤에 부른다).
  #emit(event) {
    try { this.onEvent(event); } catch (e) { this.log(`onEvent(${event?.type}): ${e?.message || e}`); }
  }

  #setConn(c) {
    if (this.#conn === c) return;
    this.#conn = c;
    this.#emit({ type: 'connection', state: c });
  }

  #file(peer) { return path.join(this.dir, `${safePeer(peer)}.ndjson`); }

  async load() {
    this.#items.clear();
    await ensureDir(this.dir);
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { names = []; }
    for (const f of names.filter((n) => n.endsWith('.ndjson'))) {
      const items = (await readLines(path.join(this.dir, f)))
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      if (!items.length) continue;
      // 상대 번호는 파일 이름이 아니라 항목 안의 값을 정본으로 삼는다(이름 보호막과 무관하게 정확).
      this.#items.set(items[0].peer ?? f.slice(0, -7), items);
    }
    this.#outbox = (await readJson(path.join(this.stateDir, 'outbox.json'), [])) || [];
    return this;
  }

  #list(peer) {
    if (!this.#items.has(peer)) this.#items.set(peer, []);
    return this.#items.get(peer);
  }

  async #persist(peer) {
    const lines = this.#list(peer).map((i) => JSON.stringify(i)).join('\n');
    await writeFileAtomic(this.#file(peer), lines ? `${lines}\n` : '');
  }

  async #saveOutbox() { await writeJson(path.join(this.stateDir, 'outbox.json'), this.#outbox); }

  history(peer, { limit = MAX_BATCH } = {}) { return this.#list(peer).slice(-limit); }

  unread() {
    const byPeer = {};
    let total = 0;
    for (const [p, l] of this.#items) {
      const n = l.filter((i) => i.dir === 'in' && !i.read).length;
      if (n) { byPeer[p] = n; total += n; }
    }
    return { total, byPeer };
  }

  async markRead(peer) {
    let changed = false;
    for (const i of this.#list(peer)) if (i.dir === 'in' && !i.read) { i.read = true; changed = true; }
    if (!changed) return;
    await this.#persist(peer);
    this.#emit({ type: 'badge', count: this.unread().total });
  }

  #sealFor(peer, envelope) {
    const pub = this.contacts.publicKeyOf(peer);
    if (!pub) throw new Error('no pinned key for contact');
    return seal({ senderPrivateRaw: this.identity.privateRaw, senderPublicRaw: this.identity.publicRaw, recipientPublicRaw: pub, envelope });
  }

  // INSERT 한 번. 실패하면 outbox에 넣고 pending, 3회째 실패면 failed로 중단한다.
  async #push(item, row) {
    try {
      await this.supa.insert('messages', row, { returning: 'minimal' });
      item.status = 'sent';
      delete item.error;
      this.#outbox = this.#outbox.filter((o) => o.id !== item.id);
    } catch (e) {
      if (e?.code === '23505') {
        // 이미 서버에 들어간 편지(응답만 잃었던 경우) — 중복 발송이 아니다.
        item.status = 'sent';
        delete item.error;
        this.#outbox = this.#outbox.filter((o) => o.id !== item.id);
      } else {
        item.tries = (item.tries || 0) + 1;
        item.error = e?.message || String(e);
        if (item.tries >= 3) {
          item.status = 'failed';
          this.#outbox = this.#outbox.filter((o) => o.id !== item.id);
        } else {
          item.status = 'pending';
          if (!this.#outbox.some((o) => o.id === item.id)) this.#outbox.push({ id: item.id, peer: item.peer, row });
        }
      }
    }
    await this.#saveOutbox();
    await this.#persist(item.peer);
    this.#emit({ type: 'message', peer: item.peer, item });
    return item;
  }

  // 네트워크에 손대기 **전에** 편지를 디스크에 남긴다(ndjson = pending, outbox = 재시도 예약).
  // 여기서 프로그램이 죽어도 편지는 사라지지 않고, 다음 실행의 flushOutbox가 이어서 보낸다.
  async #stage(item, row, { outbox = true } = {}) {
    this.#list(item.peer).push(item);
    if (outbox && !this.#outbox.some((o) => o.id === item.id)) this.#outbox.push({ id: item.id, peer: item.peer, row });
    await this.#persist(item.peer);
    if (outbox) await this.#saveOutbox();
    this.#emit({ type: 'message', peer: item.peer, item });
  }

  async sendText(peer, text) {
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('empty');
    if ([...body].length > TEXT_MAX) throw new Error(`text too long (max ${TEXT_MAX})`);
    const id = crypto.randomUUID();
    const sealed = this.#sealFor(peer, { v: 1, kind: 'text', text: body }); // 봉투가 안 되면 기록도 남기지 않는다
    const item = { id, peer, dir: 'out', kind: 'text', text: body, at: new Date(this.now()).toISOString(), status: 'pending', read: true };
    const row = { client_id: id, sender: this.#me(), recipient: peer, kind: 'text', body: sealed };
    await this.#stage(item, row);
    return this.#push(item, row);
  }

  async sendFile(peer, { name, data } = {}) {
    if (!Buffer.isBuffer(data) || !data.length) throw new Error('empty file');
    if (data.length > FILE_MAX) throw new Error(`file too large (max ${FILE_MAX})`);
    const id = crypto.randomUUID();
    const storagePath = `${this.#me()}/${id}`;
    const sealed = sealFile(data);
    const envelope = { v: 1, kind: 'file', name: safeName(name), size: data.length, key: sealed.key, storagePath };
    const body = this.#sealFor(peer, envelope);
    const item = { id, peer, dir: 'out', kind: 'file', file: { name: envelope.name, size: envelope.size, key: sealed.key, storagePath }, at: new Date(this.now()).toISOString(), status: 'pending', read: true };
    const row = { client_id: id, sender: this.#me(), recipient: peer, kind: 'file', body, file_path: storagePath };
    // 올리기 전에는 outbox에 넣지 않는다 — 파일이 아직 Storage에 없는데 INSERT만 재시도하면
    // 받는 쪽이 열 수 없는 편지가 된다. 기록(pending)은 먼저 남긴다.
    await this.#stage(item, row, { outbox: false });
    try {
      await this.supa.upload('files', storagePath, sealed.data);
    } catch (e) {
      item.status = 'failed';
      item.error = `upload: ${e?.message || e}`;
      await this.#persist(peer);
      this.#emit({ type: 'message', peer, item });
      return item;
    }
    // 파일이 자리에 놓인 뒤에야 편지를 재시도 예약에 올린다.
    if (!this.#outbox.some((o) => o.id === item.id)) this.#outbox.push({ id: item.id, peer, row });
    await this.#saveOutbox();
    return this.#push(item, row);
  }

  // 받기 버튼을 눌렀을 때만 내려받는다(자동 다운로드 없음).
  async fetchFile(itemId) {
    for (const [peer, list] of this.#items) {
      const item = list.find((i) => i.id === itemId);
      if (!item) continue;
      if (item.kind !== 'file' || !item.file) throw new Error('not a file');
      if (item.file.savedPath && fs.existsSync(item.file.savedPath)) return item.file.savedPath;
      // 내려받기 전 두 가지를 다시 확인한다: ① 주소가 보낸 이 자기 칸인가 ② 크기가 약속대로인가.
      const owner = item.dir === 'in' ? item.peer : this.#me();
      if (!okStoragePath(owner, item.file.storagePath)) throw new Error('bad file path');
      const claimed = Number(item.file.size) > 0 ? Number(item.file.size) : FILE_MAX;
      const cap = Math.min(claimed, FILE_MAX) + SEAL_OVERHEAD;
      const sealed = await this.supa.download('files', item.file.storagePath);
      if (!Buffer.isBuffer(sealed) || sealed.length > cap) throw new Error('file too large');
      const data = openFile(sealed, item.file.key);
      if (data.length > FILE_MAX) throw new Error('file too large');
      await ensureDir(this.filesDir);
      const head = String(item.id).slice(0, 8);
      let out = path.join(this.filesDir, `${head}-${item.file.name}`);
      for (let k = 2; fs.existsSync(out); k += 1) out = path.join(this.filesDir, `${head}-${k}-${item.file.name}`);
      await writeFileAtomic(out, data);
      item.file.savedPath = out;
      await this.#persist(peer);
      this.#emit({ type: 'message', peer, item });
      return out;
    }
    throw new Error('no such item');
  }

  flushOutbox() { return this.#serial('outbox', () => this.#flushOutbox()); }

  async #flushOutbox() {
    for (const entry of [...this.#outbox]) {
      const item = this.#list(entry.peer).find((i) => i.id === entry.id);
      if (!item) { this.#outbox = this.#outbox.filter((o) => o !== entry); continue; }
      if (item.status === 'sent' || item.status === 'failed') { this.#outbox = this.#outbox.filter((o) => o !== entry); continue; }
      await this.#push(item, entry.row); // #push가 성공·중단 시 outbox에서 내린다
    }
    await this.#saveOutbox();
  }

  // 미배달 편지를 훑어 복호화·저장하고 배달 표시를 남긴다(웹소켓을 놓쳤을 때의 안전망).
  gapFill() { return this.#serial('gap', () => this.#gapFill()); }

  // 한 줄(서버) → 한 항목(로컬)으로 옮긴다. 열쇠·봉투·파일 주소를 여기서 전부 검사한다.
  #toItem(r) {
    const item = { id: r.client_id, peer: r.sender, dir: 'in', kind: r.kind === 'file' ? 'file' : 'text', at: r.created_at, status: 'received', read: false };
    const pub = this.contacts.publicKeyOf(r.sender);
    if (!pub) {
      item.status = 'failed';
      item.error = 'unknown sender';
      return item;
    }
    try {
      const env = open({ recipientPrivateRaw: this.identity.privateRaw, recipientPublicRaw: this.identity.publicRaw, senderPublicRaw: pub, blob: r.body });
      if (env?.v !== 1 || (env.kind !== 'text' && env.kind !== 'file')) {
        item.status = 'unsupported'; // 새 버전의 모듈이 보낸 편지 — 버리지 않고 보관만 한다
        item.raw = r.body;
      } else if (env.kind === 'text') {
        item.kind = 'text';
        item.text = String(env.text ?? '').slice(0, TEXT_MAX);
      } else {
        item.kind = 'file';
        const storagePath = String(env.storagePath || r.file_path || '');
        item.file = { name: safeName(env.name), size: Number(env.size) || 0, key: String(env.key), storagePath };
        // 보낸 이가 자기 칸이 아닌 주소를 적어 보내면 받지 않는다(남의 칸을 대신 읽어 주지 않는다).
        if (!okStoragePath(r.sender, storagePath)) {
          item.status = 'failed';
          item.error = 'bad file path';
        } else if (item.file.size > FILE_MAX) {
          item.status = 'failed';
          item.error = 'file too large';
        }
      }
    } catch {
      item.status = 'failed';
      item.error = 'cannot open';
    }
    return item;
  }

  async #gapFill() {
    const me = this.#me();
    let total = 0;
    // 한 쪽(200줄)씩 끊어 가져온다. 배달 표시를 남기면 다음 쪽에는 그다음 편지가 올라온다.
    for (let page = 0; page < 50; page += 1) {
      const rows = await this.supa.select(
        'messages',
        `select=id,client_id,sender,kind,body,file_path,created_at&recipient=eq.${me}&delivered_at=is.null&order=created_at.asc&limit=${MAX_BATCH}`,
      ) || [];
      if (!rows.length) break;
      total += rows.length;
      const ids = [];
      const touched = new Set();
      const fresh = [];
      for (const r of rows) {
        ids.push(r.id);
        const list = this.#list(r.sender);
        if (list.some((i) => i.id === r.client_id)) continue; // 같은 편지를 두 번 저장하지 않는다
        const item = this.#toItem(r);
        list.push(item);
        touched.add(r.sender);
        fresh.push(item);
      }
      // ① 먼저 디스크에 남기고 ② 배달 표시를 남긴 뒤 ③ 화면에 알린다.
      // 화면 콜백이 터져도 편지는 이미 안전하다(알림만 놓친다).
      for (const peer of touched) await this.#persist(peer);
      let marked = true;
      try {
        await this.supa.rpc('mark_delivered', { p_ids: ids }); // 열지 못한 편지도 표시한다 — 서버에 영원히 남지 않게
      } catch (e) {
        marked = false;
        this.log(`mark_delivered: ${e.message}`);
      }
      for (const item of fresh) this.#emit({ type: 'message', peer: item.peer, item });
      this.#emit({ type: 'badge', count: this.unread().total });
      // 표시를 못 남겼으면 다음 쪽도 같은 줄이 올라온다 → 여기서 멈춘다.
      if (!marked || rows.length < MAX_BATCH) break;
    }
    return total;
  }

  start() {
    if (!this.#stopped) return this.settle();
    this.#stopped = false;
    this.#fails = 0;
    this.#backoff = BACKOFF_MIN;
    return this.#bg(this.#connect());
  }

  stop() {
    this.#stopped = true;
    try { this.#sub?.close(); } catch { /* 이미 닫힌 구독 */ }
    this.#sub = null;
    this.timers.clearInterval(this.#poll);
    this.timers.clearTimeout(this.#retryWs);
    this.#poll = null;
    this.#retryWs = null;
    this.#setConn('stopped');
  }

  async #connect() {
    if (this.#stopped) return;
    try {
      await this.gapFill();
      await this.flushOutbox();
    } catch (e) {
      this.log(`gapFill: ${e.message}`);
    }
    if (this.#stopped) return;
    let dead = false;
    try {
      const sub = this.supa.subscribe({
        table: 'messages',
        filter: `recipient=eq.${this.#me()}`,
        onChange: () => { this.#bg(this.gapFill()); },
        onStatus: (s) => { if (s !== 'open') dead = true; this.#onStatus(s); },
      });
      // 구독이 만들어지는 사이에 이미 끊겼다면(가짜·실제 모두 동기 호출 가능) 들고 있지 않는다.
      if (dead || this.#stopped) { try { sub.close(); } catch { /* noop */ } } else this.#sub = sub;
    } catch (e) {
      this.log(`subscribe: ${e.message}`);
      this.#onStatus('error');
    }
  }

  #onStatus(s) {
    if (this.#stopped) return;
    if (s === 'open') {
      this.#fails = 0;
      this.#backoff = BACKOFF_MIN;
      this.timers.clearInterval(this.#poll);
      this.#poll = null;
      this.#setConn('online');
      this.#bg(this.gapFill()); // 끊긴 사이에 온 편지를 곧바로 메운다
      return;
    }
    try { this.#sub?.close(); } catch { /* noop */ }
    this.#sub = null;
    this.#fails += 1;
    this.timers.clearTimeout(this.#retryWs);
    if (this.#fails >= 3) {
      this.#setConn('slow');
      if (!this.#poll) {
        this.#poll = this.timers.setInterval(() => { this.#bg(this.gapFill()); this.#bg(this.flushOutbox()); }, POLL_MS);
      }
      this.#retryWs = this.timers.setTimeout(() => this.#bg(this.#connect()), WS_RETRY_MS);
    } else {
      this.#setConn('offline');
      const delay = this.#backoff;
      this.#backoff = Math.min(BACKOFF_MAX, this.#backoff * 2);
      this.#retryWs = this.timers.setTimeout(() => this.#bg(this.#connect()), delay);
    }
  }
}
