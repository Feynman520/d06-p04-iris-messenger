// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 연락처: 초대 코드(8자 코드 + 상대 공개키 지문 4자)로 상호 수락한 뒤, 상대 공개키를
// 로컬 contacts.json에 고정(pin)한다. 서버 profiles.public_key는 참고값일 뿐이며,
// 신뢰의 기준은 언제나 pin된 값이다(publicKeyOf는 서버 값을 절대 돌려주지 않는다).
import path from 'node:path';
import { readJson, writeJson, ensureDir } from './store.mjs';
import { fingerprint, b64 } from './keys.mjs';

export const INVITE_RE = /^IRIS-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})$/i;

// 공백 제거 · 전각/변형 대시 → '-' · 대문자화 후 IRIS-XXXX-XXXX-XXXX 형식을 검사한다.
export function parseInvite(str) {
  const norm = String(str ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[‐-―－]/g, '-')
    .toUpperCase();
  const m = INVITE_RE.exec(norm);
  if (!m) return null;
  return { code8: m[1] + m[2], fp4: m[3] };
}

const MSG_INVALID = 'invalid or expired invite';
const MSG_RATE_LIMITED = 'too many attempts, wait a minute';
const MSG_BLOCKED = 'blocked';

export class Contacts {
  #stateDir; #supa; #identity; #me;
  #pins = {}; // id -> { displayName, publicKey(b64), keyVersion, pinnedAt }
  #state = new Map(); // id -> { status, requestedByMe, keyChanged, live: {displayName, publicKey(b64), keyVersion} | null }

  constructor({ stateDir, supa, identity, me }) {
    this.#stateDir = stateDir;
    this.#supa = supa;
    this.#identity = identity;
    this.#me = me;
  }

  get #file() {
    return path.join(this.#stateDir, 'contacts.json');
  }

  async load() {
    const obj = await readJson(this.#file, { pins: {} });
    this.#pins = obj?.pins || {};
    return this.list();
  }

  async #persist() {
    await ensureDir(this.#stateDir);
    await writeJson(this.#file, { pins: this.#pins });
  }

  #entry(id) {
    const pin = this.#pins[id];
    const st = this.#state.get(id);
    if (!pin && !st) return null;
    const displayName = pin?.displayName ?? st?.live?.displayName ?? null;
    const publicKey = pin?.publicKey ?? st?.live?.publicKey ?? null;
    const keyVersion = pin?.keyVersion ?? st?.live?.keyVersion ?? null;
    return {
      id,
      displayName,
      fingerprint: publicKey ? fingerprint(b64.dec(publicKey)) : null,
      status: st?.status ?? (pin ? 'accepted' : null),
      publicKey,
      keyVersion,
      keyChanged: st?.keyChanged ?? false,
      // 초대 코드로 지문을 맞춰 본 적 없이 sync()가 먼저 고정한 열쇠 — 화면이 "지문 재확인 필요"로 표시한다.
      needsVerify: !!pin?.needsVerify,
      requestedByMe: st?.requestedByMe ?? false,
    };
  }

  list() {
    const ids = new Set([...Object.keys(this.#pins), ...this.#state.keys()]);
    const out = [];
    for (const id of ids) {
      const e = this.#entry(id);
      if (e) out.push(e);
    }
    return out;
  }

  get(id) {
    return this.#entry(id);
  }

  async createInvite() {
    const code = String(await this.#supa.rpc('create_invite', {})).toUpperCase();
    return `IRIS-${code.slice(0, 4)}-${code.slice(4)}-${this.#identity.fingerprint.slice(0, 4)}`;
  }

  async acceptInvite(str) {
    const parsed = parseInvite(str);
    if (!parsed) throw new Error('bad invite code');
    const rows = await this.#supa.rpc('lookup_invite', { p_code: parsed.code8 });
    const row = rows?.[0];
    if (!row) throw new Error(MSG_INVALID);
    const fp = fingerprint(b64.dec(row.public_key));
    if (fp.slice(0, 4) !== parsed.fp4) throw new Error('fingerprint mismatch');
    const acceptRows = await this.#supa.rpc('accept_invite', { p_code: parsed.code8 });
    const { other_id: otherId, status } = acceptRows?.[0] ?? {};
    if (status === 'invalid') throw new Error(MSG_INVALID);
    if (status === 'rate_limited') throw new Error(MSG_RATE_LIMITED);
    if (status === 'blocked') throw new Error(MSG_BLOCKED);
    // 상대 번호가 없으면 누구의 열쇠인지도 모른다 — 고정(pin)하지 않는다.
    if (!otherId) throw new Error(MSG_INVALID);
    const live = { displayName: row.display_name, publicKey: row.public_key, keyVersion: row.key_version };
    this.#pins[otherId] = { ...live, pinnedAt: Date.now() };
    await this.#persist();
    // accept_invite 성공 시 내가 requested_by(서버 계약) → pending이면 상대 응답 대기(pending_out).
    const mapped = status === 'pending' ? 'pending_out' : status;
    this.#state.set(otherId, { status: mapped, requestedByMe: true, keyChanged: false, live });
    return { id: otherId, displayName: row.display_name, fingerprint: fp };
  }

  async respond(id, action) {
    const result = await this.#supa.rpc('respond_contact', { p_other: id, p_action: action });
    if (action === 'accept') {
      let live = this.#state.get(id)?.live ?? null;
      if (!live) {
        const rows = await this.#supa.select('profiles', `select=id,display_name,public_key,key_version&id=in.(${id})`);
        const p = rows?.[0];
        live = p ? { displayName: p.display_name, publicKey: p.public_key, keyVersion: p.key_version } : null;
      }
      // 받은 요청을 수락하는 쪽은 아직 상대의 지문을 대조한 적이 없다 — 초대 코드의 뒤 4자는
      // 요청한 쪽이 내 지문을 확인한 것이지 그 반대가 아니다. 그래서 sync() 고정과 똑같이
      // "재확인 필요" 표식을 달아 둔다(편지를 열려면 열쇠는 있어야 하므로 고정 자체는 한다).
      if (live) {
        this.#pins[id] = { ...live, pinnedAt: Date.now(), pinnedBy: 'accept', needsVerify: true };
        await this.#persist();
      }
      this.#state.set(id, { status: 'accepted', requestedByMe: false, keyChanged: false, live });
    } else if (action === 'reject' || action === 'remove') {
      delete this.#pins[id];
      await this.#persist();
      this.#state.delete(id);
    } else if (action === 'block') {
      const prev = this.#state.get(id);
      this.#state.set(id, { status: 'blocked_by_me', requestedByMe: prev?.requestedByMe ?? false, keyChanged: prev?.keyChanged ?? false, live: prev?.live ?? null });
    } else if (action === 'unblock') {
      const prev = this.#state.get(id);
      this.#state.set(id, { status: 'accepted', requestedByMe: prev?.requestedByMe ?? false, keyChanged: prev?.keyChanged ?? false, live: prev?.live ?? null });
    }
    return result;
  }

  async sync() {
    const meId = this.#me();
    const rows = (await this.#supa.select('contacts', 'select=user_a,user_b,status,requested_by,blocked_by')) || [];
    const mine = rows.filter((r) => r.user_a === meId || r.user_b === meId);
    const otherIds = mine.map((r) => (r.user_a === meId ? r.user_b : r.user_a));
    let profiles = [];
    if (otherIds.length) {
      profiles = (await this.#supa.select('profiles', `select=id,display_name,public_key,key_version&id=in.(${otherIds.join(',')})`)) || [];
    }
    const byId = new Map(profiles.map((p) => [p.id, p]));
    let dirty = false;
    for (const row of mine) {
      const other = row.user_a === meId ? row.user_b : row.user_a;
      const requestedByMe = row.requested_by === meId;
      let status;
      if (row.status === 'pending') status = requestedByMe ? 'pending_out' : 'pending_in';
      else if (row.status === 'blocked') status = row.blocked_by === meId ? 'blocked_by_me' : 'blocked_me';
      else status = row.status;
      const p = byId.get(other);
      const live = p ? { displayName: p.display_name, publicKey: p.public_key, keyVersion: p.key_version } : (this.#state.get(other)?.live ?? null);
      const pin = this.#pins[other];
      let keyChanged = false;
      if (pin && p) keyChanged = pin.publicKey !== p.public_key || pin.keyVersion !== p.key_version;
      // 고정된 열쇠가 아직 없는 수락된 관계(상대가 먼저 수락했거나, 열쇠 파일만 잃은 경우):
      // 편지를 열려면 열쇠가 있어야 하므로 서버 값을 일단 고정하되(trust on first use),
      // 사람이 지문을 직접 대조하기 전까지는 "재확인 필요" 표식을 달아 둔다.
      if (status === 'accepted' && !pin && p) {
        this.#pins[other] = { ...live, pinnedAt: Date.now(), pinnedBy: 'sync', needsVerify: true };
        dirty = true;
      }
      this.#state.set(other, { status, requestedByMe, keyChanged, live });
    }
    if (dirty) await this.#persist();
    return this.list();
  }

  // 사용자가 지문을 눈으로 확인했을 때만 호출: pin을 서버(=현재 live) 값으로 교체하고
  // "재확인 필요" 표식(needsVerify·pinnedBy)을 떨어뜨린다 — 이제 사람이 직접 확인한 열쇠다.
  acceptKeyChange(id) {
    const st = this.#state.get(id);
    const src = st?.live ?? this.#pins[id];
    if (!src) return;
    this.#pins[id] = { displayName: src.displayName, publicKey: src.publicKey, keyVersion: src.keyVersion, pinnedAt: Date.now() };
    if (st) this.#state.set(id, { ...st, keyChanged: false });
    // 메모리에는 곧바로 반영되고 디스크 쓰기는 배경으로 돈다 — 기다리고 싶은 쪽(시험 등)은 이 약속을 받는다.
    return this.#persist().catch(() => {});
  }

  // 고정된(pin) 공개키만 반환한다 — 서버가 알려주는 최신 값이 아니다.
  publicKeyOf(id) {
    const pin = this.#pins[id];
    return pin ? b64.dec(pin.publicKey) : null;
  }
}
