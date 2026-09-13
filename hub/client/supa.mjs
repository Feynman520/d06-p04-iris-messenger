// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// Supabase 최소 클라이언트(외부 의존 0): GoTrue(OTP)·PostgREST·Storage·Realtime 도어벨. 재연결·저장은 호출자 몫.
export class SupaError extends Error { constructor(msg, { status = 0, code = null, details = null } = {}) { super(msg); this.name = 'SupaError'; this.status = status; this.code = code; this.details = details; } }
export class Supa {
  #s = null; #listeners = []; #refreshing = null;
  constructor({ url, anonKey, fetch = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = () => {} }) {
    if (!/^https?:\/\//.test(url || '')) throw new SupaError('bad hub url');
    Object.assign(this, { url: url.replace(/\/+$/, ''), anonKey, fetch, WebSocketImpl, log });
  }
  get session() { return this.#s; }
  setSession(s) { this.#s = s ? { ...s } : null; for (const fn of this.#listeners) { try { fn(this.#s); } catch {} } }
  onSession(fn) { this.#listeners.push(fn); return () => { this.#listeners = this.#listeners.filter((x) => x !== fn); }; }
  #headers(extra = {}) { return { apikey: this.anonKey, Authorization: `Bearer ${this.#s?.access_token || this.anonKey}`, ...extra }; }
  async #req(method, p, { body, headers = {}, raw = false, retry = true } = {}) {
    let r;
    try { r = await this.fetch(this.url + p, { method, headers: this.#headers(headers), body }); }
    catch (e) { throw new SupaError(`network: ${e.message}`, { status: 0, code: 'network' }); }
    if (r.status === 401 && retry && this.#s?.refresh_token) { await this.refresh(); return this.#req(method, p, { body, headers, raw, retry: false }); }
    if (raw) { if (!r.ok) throw await this.#err(r); return Buffer.from(await r.arrayBuffer()); }
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    if (!r.ok) throw new SupaError(j?.msg || j?.message || j?.error_description || j?.error || `${method} ${p} → ${r.status}`, { status: r.status, code: j?.error_code || j?.code || null, details: j });
    return j;
  }
  async #err(r) { let j = null; try { j = JSON.parse(await r.text()); } catch {} return new SupaError(j?.message || j?.msg || `${r.status}`, { status: r.status, code: j?.error_code || j?.code || null, details: j }); }
  #adopt(j, email) { const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), user: { id: j.user?.id, email: j.user?.email || email } }; this.setSession(s); return s; }
  async otpRequest(email) { return this.#req('POST', '/auth/v1/otp', { body: JSON.stringify({ email, create_user: true }), headers: { 'Content-Type': 'application/json' }, retry: false }); }
  async otpVerify(email, token) {
    const raw = String(token).trim();
    let payload;
    if (/^https?:\/\//i.test(raw)) {
      let u;
      try { u = new URL(raw); } catch { throw new SupaError('bad code or link', { status: 400, code: 'bad_input' }); }
      const tokenHash = u.searchParams.get('token_hash') || u.searchParams.get('token');
      if (!tokenHash) throw new SupaError('bad code or link', { status: 400, code: 'bad_input' });
      // 링크의 종류를 그대로 넘긴다. 처음 가입하는 주소에는 Supabase 가 "Confirm your email"(type=signup) 링크를 보내는데,
      // 이를 magiclink 로 확인하면 서버가 다른 토큰 칸을 보아 실패한다(2026-09-13 실측: 내장 메일러의 가입 확인 메일).
      const LINK_TYPES = ['signup', 'magiclink', 'email', 'recovery', 'invite', 'email_change'];
      const linkType = String(u.searchParams.get('type') || '').toLowerCase();
      payload = { type: LINK_TYPES.includes(linkType) ? linkType : 'magiclink', token_hash: tokenHash };
    } else {
      payload = { type: 'email', email, token: raw };
    }
    const j = await this.#req('POST', '/auth/v1/verify', { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' }, retry: false });
    return this.#adopt(j, email);
  }
  async refresh() {
    if (this.#refreshing) return this.#refreshing;
    const rt = this.#s?.refresh_token; if (!rt) throw new SupaError('no refresh token', { status: 401, code: 'signed_out' });
    this.#refreshing = (async () => {
      try { const j = await this.#req('POST', '/auth/v1/token?grant_type=refresh_token', { body: JSON.stringify({ refresh_token: rt }), headers: { 'Content-Type': 'application/json' }, retry: false }); return this.#adopt(j, this.#s?.user?.email); }
      catch (e) { if (e.status === 400 || e.status === 401 || e.status === 403) this.setSession(null); throw e; }
      finally { this.#refreshing = null; }
    })();
    return this.#refreshing;
  }
  async ensureFresh() { if (this.#s && this.#s.expires_at - Math.floor(Date.now() / 1000) < 120) await this.refresh(); }
  async logout() { try { if (this.#s) await this.#req('POST', '/auth/v1/logout', { retry: false }); } catch {} this.setSession(null); }
  async select(table, query = '') { await this.ensureFresh(); return this.#req('GET', `/rest/v1/${table}${query ? '?' + query : ''}`); }
  async insert(table, row, { returning = 'representation' } = {}) { await this.ensureFresh(); const j = await this.#req('POST', `/rest/v1/${table}`, { body: JSON.stringify(row), headers: { 'Content-Type': 'application/json', Prefer: `return=${returning}` } }); return Array.isArray(j) ? j[0] ?? null : j; }
  async update(table, query, patch) { await this.ensureFresh(); return this.#req('PATCH', `/rest/v1/${table}?${query}`, { body: JSON.stringify(patch), headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' } }); }
  async rpc(fn, args = {}) { await this.ensureFresh(); return this.#req('POST', `/rest/v1/rpc/${fn}`, { body: JSON.stringify(args), headers: { 'Content-Type': 'application/json' } }); }
  async upload(bucket, objPath, data) { await this.ensureFresh(); return this.#req('POST', `/storage/v1/object/${bucket}/${objPath}`, { body: data, headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' } }); }
  async download(bucket, objPath) { await this.ensureFresh(); return this.#req('GET', `/storage/v1/object/${bucket}/${objPath}`, { raw: true }); }
  subscribe({ table, filter, onChange, onStatus = () => {} }) {
    const WS = this.WebSocketImpl; if (!WS) throw new SupaError('WebSocket unavailable');
    const wsUrl = this.url.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(this.anonKey)}&vsn=1.0.0`;
    let ref = 0, hb = null, closed = false, joinRef = null, joined = false; const ws = new WS(wsUrl);
    const send = (o) => { const r = String(++ref); try { ws.send(JSON.stringify({ ...o, ref: r })); } catch {} return r; };
    const off = this.onSession((s) => { if (s?.access_token && ws.readyState === 1) send({ topic: 'realtime:inbox', event: 'access_token', payload: { access_token: s.access_token } }); });
    // 'open'은 소켓이 열린 순간이 아니라 **서버가 구독(postgres_changes)을 받아들였다고 답한 뒤**에만 켠다.
    // 소켓만 열린 상태에서 켜면 그 직후에 온 편지가 도어벨을 놓친다(2026-09-13 라이브 실측).
    ws.onopen = () => { joinRef = send({ topic: 'realtime:inbox', event: 'phx_join', payload: { config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table, filter }] }, access_token: this.#s?.access_token } }); hb = setInterval(() => send({ topic: 'phoenix', event: 'heartbeat', payload: {} }), 30000); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.event === 'postgres_changes') { try { onChange(m.payload?.data?.record || null); } catch (e) { this.log(`onChange error: ${e.message}`); } } else if (m.event === 'phx_reply') { if (m.payload?.status === 'error') { this.log(`realtime join error: ${JSON.stringify(m.payload).slice(0, 200)}`); onStatus('error'); } else if (m.payload?.status === 'ok' && String(m.ref) === String(joinRef) && !joined) { joined = true; onStatus('open'); } } };
    ws.onerror = () => { if (!closed) onStatus('error'); };
    ws.onclose = () => { clearInterval(hb); off(); if (!closed) { closed = true; onStatus('closed'); } };
    return { close() { if (closed) return; closed = true; clearInterval(hb); off(); try { ws.close(); } catch {} } };
  }
}
