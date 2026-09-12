// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 시험용 가짜 허브(메모리): messages 표(client_id UNIQUE) · mark_delivered · Storage · 도어벨
// + 로그인(OTP)·profiles·contacts·meta·초대 rpc(Task 9의 App 시험용).
// 실제 Supa와 같은 메서드 이름·같은 SupaError를 던진다. 네트워크·파일은 쓰지 않는다.
import crypto from 'node:crypto';
import { SupaError } from '../../hub/client/supa.mjs';

const BASE = Date.UTC(2026, 8, 13, 0, 0, 0); // 시각 도장 기준점(테스트 재현성)

// PostgREST 필터 한 조각(`recipient=eq.<id>`)이 이 줄에 맞는지.
function matchesFilter(filter, row) {
  if (!filter) return true;
  const m = /^([a-z_]+)=eq\.(.*)$/.exec(String(filter));
  if (!m) return true;
  return String(row[m[1]] ?? '') === m[2];
}

// PostgREST 질의 문자열에서 `필드=eq.값` 하나를 꺼낸다.
function eqOf(query, field) {
  const v = new URLSearchParams(query).get(field);
  return v && v.startsWith('eq.') ? v.slice(3) : null;
}

// `id=in.(a,b)` → ['a','b']
function inOf(query, field) {
  const v = new URLSearchParams(query).get(field);
  if (!v || !v.startsWith('in.(')) return null;
  return v.slice(4, -1).split(',').filter(Boolean);
}

// select=a,b,c 가 있으면 그 열만 남긴다(PostgREST 흉내).
function project(rows, query) {
  const sel = new URLSearchParams(query).get('select');
  if (!sel || sel === '*') return rows.map((r) => ({ ...r }));
  const fields = sel.split(',');
  return rows.map((r) => { const o = {}; for (const f of fields) o[f] = r[f]; return o; });
}

export class FakeSupa {
  rows = [];             // messages 표
  profiles = [];         // profiles 표: { id, display_name, public_key, key_version }
  contactRows = [];      // contacts 표: { user_a, user_b, status, requested_by, blocked_by }
  meta = [{ key: 'schema_version', value: '1' }];
  invites = new Map();   // code8 → owner_id
  storage = new Map();   // `${bucket}/${objPath}` → Buffer
  subs = new Set();      // 살아 있는 구독
  wsMode = 'ok';         // 'ok' | 'error' — 'error'면 subscribe가 즉시 onStatus('error')
  calls = { select: 0, insert: 0, update: 0, rpc: 0, upload: 0, download: 0, subscribe: 0, otp: 0 };
  #seq = 0;
  #fails = 0;
  #failAfterWrite = false;
  #session = null;
  #listeners = [];

  // 다음 n회 요청을 네트워크 오류로 만든다. afterWrite면 "쓰기는 됐는데 응답만 잃은" 상황(V7).
  failNext(n = 1, { afterWrite = false } = {}) {
    this.#fails = n;
    this.#failAfterWrite = afterWrite;
  }

  #stamp() { return new Date(BASE + this.#seq++).toISOString(); }

  #gate(stage) {
    if (this.#fails <= 0) return;
    if ((this.#failAfterWrite ? 'after' : 'before') !== stage) return;
    this.#fails -= 1;
    throw new SupaError('network: fake offline', { status: 0, code: 'network' });
  }

  // ---- 로그인(GoTrue 흉내) ----

  get session() { return this.#session; }

  setSession(s) {
    this.#session = s ? { ...s } : null;
    for (const fn of this.#listeners) { try { fn(this.#session); } catch { /* 청취자 오류는 서버 몫이 아니다 */ } }
  }

  onSession(fn) {
    this.#listeners.push(fn);
    return () => { this.#listeners = this.#listeners.filter((x) => x !== fn); };
  }

  async ensureFresh() { /* 가짜 토큰은 만료되지 않는다 */ }

  async otpRequest(email) {
    this.calls.otp += 1;
    this.#gate('before');
    this.lastOtpEmail = email;
    return {};
  }

  // 6자리 '123456' 또는 token_hash=hash-ok 매직링크만 통과한다.
  async otpVerify(email, token) {
    const raw = String(token).trim();
    let ok = raw === '123456';
    if (/^https?:\/\//i.test(raw)) {
      try { ok = new URL(raw).searchParams.get('token_hash') === 'hash-ok'; } catch { ok = false; }
    }
    if (!ok) throw new SupaError('Token has expired or is invalid', { status: 400, code: 'otp_expired' });
    const s = { access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: this.userId || 'u1', email } };
    this.setSession(s);
    return s;
  }

  async logout() { this.setSession(null); }

  #me() { return this.#session?.user?.id ?? null; }

  async select(table, query = '') {
    this.calls.select += 1;
    this.#gate('before');
    if (table === 'meta') {
      const key = eqOf(query, 'key');
      const out = this.meta.filter((r) => !key || r.key === key);
      this.#gate('after');
      return project(out, query);
    }
    if (table === 'profiles') {
      const one = eqOf(query, 'id');
      const many = inOf(query, 'id');
      const out = this.profiles.filter((p) => (one ? p.id === one : many ? many.includes(p.id) : true));
      this.#gate('after');
      return project(out, query);
    }
    if (table === 'contacts') {
      this.#gate('after');
      return project(this.contactRows, query);
    }
    if (table !== 'messages') throw new SupaError(`fake: unknown table ${table}`, { status: 404 });
    const q = new URLSearchParams(query);
    let out = [...this.rows];
    const eq = (field) => { const v = q.get(field); if (v) out = out.filter((r) => String(r[field] ?? '') === v.replace(/^eq\./, '')); };
    eq('recipient'); eq('sender'); eq('client_id');
    if (q.get('delivered_at') === 'is.null') out = out.filter((r) => r.delivered_at == null);
    const order = q.get('order');
    if (order?.startsWith('created_at')) {
      out.sort((a, b) => (order.endsWith('.desc') ? String(b.created_at).localeCompare(a.created_at) : String(a.created_at).localeCompare(b.created_at)));
    }
    const limit = Number(q.get('limit') || 0);
    if (limit > 0) out = out.slice(0, limit);
    this.#gate('after');
    return out.map((r) => ({ ...r }));
  }

  async insert(table, row, { returning = 'representation' } = {}) {
    this.calls.insert += 1;
    this.#gate('before');
    if (table === 'profiles') {
      if (this.profiles.some((p) => p.id === row.id)) throw new SupaError('duplicate key value', { status: 409, code: '23505' });
      const stored = { ...row };
      this.profiles.push(stored);
      this.#gate('after');
      return returning === 'minimal' ? null : { ...stored };
    }
    if (table !== 'messages') throw new SupaError(`fake: unknown table ${table}`, { status: 404 });
    const stored = this.insertRow(row);
    this.#gate('after');
    return returning === 'minimal' ? null : { ...stored };
  }

  // 표에 직접 한 줄 넣기(테스트가 서버 쪽 줄을 흉내 낼 때도 씀). UNIQUE·도어벨은 그대로 적용.
  insertRow(row) {
    if (this.rows.some((r) => r.client_id === row.client_id)) {
      throw new SupaError('duplicate key value violates unique constraint "messages_client_id_key"', { status: 409, code: '23505' });
    }
    const stored = { id: crypto.randomUUID(), created_at: this.#stamp(), delivered_at: null, file_path: null, ...row };
    this.rows.push(stored);
    for (const s of [...this.subs]) {
      if (s.closed || s.table !== 'messages' || !matchesFilter(s.filter, stored)) continue;
      try { s.onChange({ ...stored }); } catch { /* 구독자 오류는 서버 몫이 아니다 */ }
    }
    return stored;
  }

  async update(table, query, patch) {
    this.calls.update += 1;
    this.#gate('before');
    if (table !== 'profiles') throw new SupaError(`fake: unknown table ${table}`, { status: 404 });
    const id = eqOf(query, 'id');
    const out = [];
    for (const p of this.profiles) if (p.id === id) { Object.assign(p, patch); out.push({ ...p }); }
    this.#gate('after');
    return out;
  }

  async rpc(fn, args = {}) {
    this.calls.rpc += 1;
    this.#gate('before');
    if (fn === 'delete_me') {
      const me = this.#me();
      this.profiles = this.profiles.filter((p) => p.id !== me);
      this.contactRows = this.contactRows.filter((r) => r.user_a !== me && r.user_b !== me);
      this.#gate('after');
      return {};
    }
    if (fn === 'create_invite') {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 8; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
      this.invites.set(code, this.#me());
      this.#gate('after');
      return code;
    }
    if (fn === 'respond_contact') {
      const me = this.#me();
      const other = args.p_other;
      const [a, b] = me < other ? [me, other] : [other, me];
      const idx = this.contactRows.findIndex((r) => r.user_a === a && r.user_b === b);
      if (idx < 0) throw new SupaError('no such contact', { status: 400 });
      const row = this.contactRows[idx];
      let result = 'accepted';
      if (args.p_action === 'accept') row.status = 'accepted';
      else if (args.p_action === 'reject' || args.p_action === 'remove') { this.contactRows.splice(idx, 1); result = 'deleted'; }
      else if (args.p_action === 'block') { row.status = 'blocked'; row.blocked_by = me; result = 'blocked'; }
      else if (args.p_action === 'unblock') { row.status = 'accepted'; row.blocked_by = null; }
      else throw new SupaError('unknown action', { status: 400 });
      this.#gate('after');
      return result;
    }
    if (fn !== 'mark_delivered') throw new SupaError(`fake: unknown rpc ${fn}`, { status: 404 });
    const ids = new Set(args.p_ids || []);
    let n = 0;
    for (const r of this.rows) if (ids.has(r.id) && r.delivered_at == null) { r.delivered_at = this.#stamp(); n += 1; }
    this.#gate('after');
    return n;
  }

  async upload(bucket, objPath, data) {
    this.calls.upload += 1;
    this.#gate('before');
    const key = `${bucket}/${objPath}`;
    if (this.storage.has(key)) throw new SupaError('duplicate', { status: 409, code: 'Duplicate' });
    this.storage.set(key, Buffer.from(data));
    this.#gate('after');
    return { Key: key };
  }

  async download(bucket, objPath) {
    this.calls.download += 1;
    this.#gate('before');
    const buf = this.storage.get(`${bucket}/${objPath}`);
    if (!buf) throw new SupaError('not found', { status: 404 });
    this.#gate('after');
    return Buffer.from(buf);
  }

  subscribe({ table, filter, onChange = () => {}, onStatus = () => {} }) {
    this.calls.subscribe += 1;
    if (this.wsMode === 'error') { onStatus('error'); return { close() {} }; }
    const sub = { table, filter, onChange, onStatus, closed: false };
    this.subs.add(sub);
    const self = this;
    onStatus('open');
    return { close() { if (sub.closed) return; sub.closed = true; self.subs.delete(sub); } };
  }

  // 테스트가 도어벨을 직접 누른다.
  ring(record = null) { for (const s of [...this.subs]) if (!s.closed) s.onChange(record); }

  // 웹소켓이 끊긴 상황: 살아 있는 구독 전부에 onStatus('closed').
  drop() {
    for (const s of [...this.subs]) {
      s.closed = true;
      this.subs.delete(s);
      s.onStatus('closed');
    }
  }
}

// 테스트용 가짜 타이머: 등록만 하고, 테스트가 fire()로 직접 터뜨린다(대기 시간 0).
export function fakeTimers() {
  const map = new Map();
  let seq = 0;
  const api = {
    setTimeout: (fn, ms) => { const id = ++seq; map.set(id, { id, fn, ms, kind: 'timeout' }); return id; },
    clearTimeout: (id) => { map.delete(id); },
    setInterval: (fn, ms) => { const id = ++seq; map.set(id, { id, fn, ms, kind: 'interval' }); return id; },
    clearInterval: (id) => { map.delete(id); },
    pending: () => [...map.values()].map(({ id, ms, kind }) => ({ id, ms, kind })),
    fire: (id) => {
      const e = map.get(id);
      if (!e) throw new Error(`no such timer: ${id}`);
      if (e.kind === 'timeout') map.delete(id);
      return e.fn();
    },
  };
  api.fireFirst = (kind) => {
    const e = api.pending().find((x) => x.kind === kind);
    if (!e) throw new Error(`no pending ${kind}`);
    return api.fire(e.id);
  };
  return api;
}
