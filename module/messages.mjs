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

  get connection() { return this.#conn; }

  #setConn(c) {
    if (this.#conn === c) return;
    this.#conn = c;
    this.onEvent({ type: 'connection', state: c });
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
    this.onEvent({ type: 'badge', count: this.unread().total });
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
    this.onEvent({ type: 'message', peer: item.peer, item });
    return item;
  }

  async sendText(peer, text) {
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('empty');
    if ([...body].length > TEXT_MAX) throw new Error(`text too long (max ${TEXT_MAX})`);
    const id = crypto.randomUUID();
    const sealed = this.#sealFor(peer, { v: 1, kind: 'text', text: body }); // 봉투가 안 되면 기록도 남기지 않는다
    const item = { id, peer, dir: 'out', kind: 'text', text: body, at: new Date(this.now()).toISOString(), status: 'pending', read: true };
    this.#list(peer).push(item);
    return this.#push(item, { client_id: id, sender: this.#me(), recipient: peer, kind: 'text', body: sealed });
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
    this.#list(peer).push(item);
    try {
      await this.supa.upload('files', storagePath, sealed.data);
    } catch (e) {
      // 올리지 못한 파일은 재시도해도 같은 자리에 다시 올려야 하므로 outbox에 넣지 않는다.
      item.status = 'failed';
      item.error = `upload: ${e?.message || e}`;
      await this.#persist(peer);
      this.onEvent({ type: 'message', peer, item });
      return item;
    }
    return this.#push(item, { client_id: id, sender: this.#me(), recipient: peer, kind: 'file', body, file_path: storagePath });
  }

  // 받기 버튼을 눌렀을 때만 내려받는다(자동 다운로드 없음).
  async fetchFile(itemId) {
    for (const [peer, list] of this.#items) {
      const item = list.find((i) => i.id === itemId);
      if (!item) continue;
      if (item.kind !== 'file' || !item.file) throw new Error('not a file');
      if (item.file.savedPath && fs.existsSync(item.file.savedPath)) return item.file.savedPath;
      const sealed = await this.supa.download('files', item.file.storagePath);
      const data = openFile(sealed, item.file.key);
      await ensureDir(this.filesDir);
      const head = String(item.id).slice(0, 8);
      let out = path.join(this.filesDir, `${head}-${item.file.name}`);
      for (let k = 2; fs.existsSync(out); k += 1) out = path.join(this.filesDir, `${head}-${k}-${item.file.name}`);
      await writeFileAtomic(out, data);
      item.file.savedPath = out;
      await this.#persist(peer);
      this.onEvent({ type: 'message', peer, item });
      return out;
    }
    throw new Error('no such item');
  }

  async flushOutbox() {
    for (const entry of [...this.#outbox]) {
      const item = this.#list(entry.peer).find((i) => i.id === entry.id);
      if (!item) { this.#outbox = this.#outbox.filter((o) => o !== entry); continue; }
      if (item.status === 'sent' || item.status === 'failed') { this.#outbox = this.#outbox.filter((o) => o !== entry); continue; }
      await this.#push(item, entry.row); // #push가 성공·중단 시 outbox에서 내린다
    }
    await this.#saveOutbox();
  }

  // 미배달 편지를 훑어 복호화·저장하고 배달 표시를 남긴다(웹소켓을 놓쳤을 때의 안전망).
  async gapFill() {
    const me = this.#me();
    const rows = await this.supa.select(
      'messages',
      `select=id,client_id,sender,kind,body,file_path,created_at&recipient=eq.${me}&delivered_at=is.null&order=created_at.asc&limit=${MAX_BATCH}`,
    ) || [];
    const ids = [];
    const touched = new Set();
    for (const r of rows) {
      ids.push(r.id);
      const list = this.#list(r.sender);
      if (list.some((i) => i.id === r.client_id)) continue; // 같은 편지를 두 번 저장하지 않는다
      const item = { id: r.client_id, peer: r.sender, dir: 'in', kind: r.kind === 'file' ? 'file' : 'text', at: r.created_at, status: 'received', read: false };
      const pub = this.contacts.publicKeyOf(r.sender);
      if (!pub) {
        item.status = 'failed';
        item.error = 'unknown sender';
      } else {
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
            item.file = { name: safeName(env.name), size: Number(env.size) || 0, key: String(env.key), storagePath: String(env.storagePath || r.file_path || '') };
          }
        } catch {
          item.status = 'failed';
          item.error = 'cannot open';
        }
      }
      list.push(item);
      touched.add(r.sender);
      this.onEvent({ type: 'message', peer: r.sender, item });
    }
    for (const peer of touched) await this.#persist(peer);
    if (ids.length) {
      // 열지 못한 편지도 배달 표시를 남긴다 — 서버에 영원히 남지 않게.
      try { await this.supa.rpc('mark_delivered', { p_ids: ids }); } catch (e) { this.log(`mark_delivered: ${e.message}`); }
      this.onEvent({ type: 'badge', count: this.unread().total });
    }
    return rows.length;
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
