// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 응용 상태: Face가 준 state 폴더 하나에 Supa·Session·Identity·Contacts·Messages를 묶고
// 화면이 그릴 수 있는 한 덩어리 state()로 내놓는다. 화면(api.mjs)과 전선(index.mjs)은 이 class만 쓴다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supa } from '../hub/client/supa.mjs';
import { Session } from '../hub/client/session.mjs';
import { Identity } from '../hub/client/identity.mjs';
import { Contacts } from '../hub/client/contacts.mjs';
import { b64 } from '../hub/client/keys.mjs';
import { readJson, writeJson } from '../hub/client/store.mjs';
import { Messages, TEXT_MAX, FILE_MAX, RISKY_EXT } from './messages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NAME_MAX = 40; // 표시 이름 글자 수 상한(화면·API가 같은 값을 쓴다)

// 단계(stage): nohub 허브 주소 없음 · out 로그인 전 · code 코드 입력 대기 · identity 열쇠 없음 · in 사용 가능
export class App {
  #listeners = [];
  #pendingEmail = null;

  constructor({ makeSupa, dpapi, log = () => {} } = {}) {
    this.log = log;
    this.dpapi = dpapi; // undefined면 Session·Identity가 실제 DPAPI를 쓴다
    this.makeSupa = makeSupa || ((conf) => new Supa({ ...conf, log }));
    this.stateDir = null;
    this.supa = null;
    this.session = null;
    this.identity = null;
    this.contacts = null;
    this.messages = null;
    this.settings = {};
    this.hubConf = null;
    this.hubCustom = false;
    this.hubMismatch = null;
    this.keyMismatch = false; // 서버가 아는 내 공개키 ≠ 이 컴퓨터의 열쇠
    this.displayName = null;
    this.theme = null;
    this.lang = 'ko';
    this.face = null;
    this.version = '0.0.0';
    this.hubRange = { min: 1, max: 1 };
  }

  // Face의 hello 내용(테마·언어·본체 판번호)을 화면에 그대로 전달하기 위해 보관한다.
  setHello({ theme, lang, face } = {}) {
    if (theme) this.theme = theme;
    if (lang) this.lang = lang;
    if (face) this.face = face;
  }

  async init({ stateDir }) {
    this.messages?.stop();
    this.stateDir = stateDir;
    this.hubMismatch = null;
    this.keyMismatch = false;
    this.#pendingEmail = null;

    const mod = (await readJson(path.join(HERE, 'module.json'), {})) || {};
    this.version = mod.version || '0.0.0';
    this.hubRange = { min: Number(mod.hub?.min ?? 1), max: Number(mod.hub?.max ?? 1) };

    this.settings = (await readJson(path.join(stateDir, 'settings.json'), {})) || {};
    this.displayName = this.settings.displayName || null;

    const fileHub = (await readJson(path.join(HERE, 'hub.json'), null)) || null;
    const custom = this.settings.hub;
    let conf = null;
    this.hubCustom = false;
    if (custom?.url && custom?.anonKey) { conf = { url: custom.url, anonKey: custom.anonKey }; this.hubCustom = true; }
    else if (fileHub?.url && fileHub?.anonKey) { conf = { url: fileHub.url, anonKey: fileHub.anonKey }; this.hubCustom = false; }
    this.hubConf = conf;

    if (!conf) { // 허브 주소가 없으면 아무 것도 만들지 않는다 — 화면이 주소를 받아 setHub()로 이어 준다
      this.supa = this.session = this.identity = this.contacts = this.messages = null;
      return this;
    }

    try {
      this.supa = this.makeSupa(conf);
    } catch (e) {
      this.log(`hub: ${e.message}`);
      this.hubConf = null;
      this.supa = this.session = this.identity = this.contacts = this.messages = null;
      return this;
    }

    const me = () => this.session?.user?.id ?? null;
    this.session = new Session({ stateDir, supa: this.supa, dpapi: this.dpapi });
    this.identity = new Identity({ stateDir, supa: this.supa, dpapi: this.dpapi });
    this.contacts = new Contacts({ stateDir, supa: this.supa, identity: this.identity, me });
    this.messages = new Messages({
      stateDir,
      supa: this.supa,
      identity: this.identity,
      contacts: this.contacts,
      me,
      onEvent: (e) => this.#emit(e),
      log: this.log,
    });

    // 여기까지는 전부 로컬 파일 읽기다 — 로그인 전에는 네트워크를 만지지 않는다.
    try { await this.session.load(); } catch (e) { this.log(`session.load: ${e.message}`); }
    await this.identity.load();
    await this.contacts.load();
    await this.messages.load();

    await this.#goLive();
    return this;
  }

  // 로그인 + 열쇠가 모두 갖춰진 뒤에만: 허브 판 확인 → 연락처 맞추기 → 편지 연결.
  async #goLive() {
    if (!this.session?.user || !this.identity?.publicRaw) return;
    await this.checkSchema();
    try {
      await this.contacts.sync();
    } catch (e) {
      this.log(`contacts.sync: ${e.message}`); // 고정(pin)된 연락처는 그대로 두고 오프라인으로 시작한다
    }
    try {
      const profile = await this.identity.fetchProfile();
      // 서버가 아는 내 공개키와 이 컴퓨터의 열쇠가 다르면(다른 기기에서 열쇠를 재설정한 경우 등)
      // 그 열쇠로는 아무 편지도 열 수 없다 — 연결하지 않고 신원 화면으로 되돌린다.
      this.keyMismatch = !!(profile?.public_key && profile.public_key !== b64.enc(this.identity.publicRaw));
      // 서버의 이름이 정본 — 다른 기기에서 바꿨거나 다른 계정으로 갈아탄 경우를 맞춘다.
      const name = profile?.display_name || null;
      if (!this.keyMismatch && name && name !== this.displayName) {
        this.displayName = name;
        await this.#saveSettings({ displayName: name });
      }
    } catch (e) {
      this.log(`profile: ${e.message}`); // 오프라인이면 마지막으로 알던 이름·판정을 그대로 쓴다
    }
    if (this.hubMismatch || this.keyMismatch) return; // 맞지 않는 허브·열쇠에는 연결하지 않는다
    this.messages.start();
  }

  // meta.schema_version 이 module.json 의 hub.min~max 밖이면 어느 쪽이 낡았는지 알린다.
  async checkSchema() {
    this.hubMismatch = null;
    if (!this.supa || !this.session?.user) return null;
    try {
      const rows = await this.supa.select('meta', 'key=eq.schema_version');
      const v = Number(rows?.[0]?.value);
      if (!Number.isFinite(v)) return null;
      if (v < this.hubRange.min) this.hubMismatch = 'hub_old';
      else if (v > this.hubRange.max) this.hubMismatch = 'module_old';
    } catch (e) {
      this.log(`checkSchema: ${e.message}`); // 판 확인에 실패했다고 사용을 막지는 않는다
    }
    return this.hubMismatch;
  }

  get notifyMuted() { return !!this.settings.notifyMuted; }

  stage() {
    if (!this.hubConf || !this.supa) return 'nohub';
    if (!this.session?.user) return this.#pendingEmail ? 'code' : 'out';
    if (!this.identity?.publicRaw || this.keyMismatch) return 'identity';
    return 'in';
  }

  // 화면이 다른 설정 파일을 읽지 않고도 전부 그릴 수 있는 한 덩어리.
  state() {
    const user = this.session?.user || null;
    return {
      stage: this.stage(),
      email: user?.email ?? this.#pendingEmail ?? null,
      user: user ? { id: user.id } : null,
      displayName: this.displayName ?? null,
      fingerprint: this.identity?.fingerprint ?? null,
      hub: { url: this.hubConf?.url ?? null, custom: this.hubCustom },
      hubMismatch: this.hubMismatch ?? null,
      keyMismatch: !!this.keyMismatch,
      connection: this.messages?.connection ?? 'stopped',
      unread: this.messages?.unread() ?? { total: 0, byPeer: {} },
      contacts: this.contacts?.list() ?? [],
      notifyMuted: !!this.settings.notifyMuted,
      theme: this.theme ?? null,
      lang: this.lang,
      version: this.version,
      limits: { textMax: TEXT_MAX, fileMax: FILE_MAX },
      riskyExt: RISKY_EXT.source,
    };
  }

  // ---- 이벤트 팬아웃 ----

  on(fn) {
    this.#listeners.push(fn);
    return () => { this.#listeners = this.#listeners.filter((x) => x !== fn); };
  }

  #emit(ev) {
    for (const fn of this.#listeners) {
      try { fn(ev); } catch (e) { this.log(`listener: ${e.message}`); }
    }
    // 연결 상태가 바뀌면 화면의 나머지(배지·연락처)도 함께 새로 그리게 한다.
    if (ev.type === 'connection') this.#emitState();
  }

  // 화면이 바꾼 것(연락처 수락 등)을 다른 화면에도 알린다.
  emitState() { this.#emitState(); }

  #emitState() {
    for (const fn of this.#listeners) {
      try { fn({ type: 'state' }); } catch (e) { this.log(`listener: ${e.message}`); }
    }
  }

  #needHub() {
    if (!this.supa) throw new Error('hub not configured');
  }

  #needSession() {
    this.#needHub();
    if (!this.session.user) throw new Error('not signed in');
  }

  // ---- 로그인 ----

  async login1(email) {
    this.#needHub();
    await this.session.requestCode(email);
    this.#pendingEmail = String(email).trim();
    this.#emitState();
    return { stage: this.stage() };
  }

  // code는 6자리 숫자이거나 메일에서 붙여넣은 매직링크 주소 — 둘 다 그대로 넘긴다.
  async login2(email, codeOrLink) {
    this.#needHub();
    await this.session.verifyCode(email, codeOrLink);
    this.#pendingEmail = null;
    await this.identity.load();
    await this.#goLive();
    this.#emitState();
    return { stage: this.stage() };
  }

  async logout() {
    this.#needHub();
    this.messages?.stop();
    await this.session.logout();
    this.#pendingEmail = null;
    this.hubMismatch = null;
    this.keyMismatch = false;
    this.#emitState();
    return { stage: this.stage() };
  }

  async deleteAccount() {
    this.#needSession();
    this.messages?.stop();
    const hub = this.settings.hub; // 내가 고른 허브 주소는 계정과 함께 지우지 않는다
    await this.session.deleteAccount(); // 서버 rpc + state 폴더 비우기
    try { await this.session.logout(); } catch (e) { this.log(`logout after delete: ${e.message}`); }
    this.settings = hub ? { hub } : {};
    if (hub) await writeJson(path.join(this.stateDir, 'settings.json'), this.settings);
    await this.init({ stateDir: this.stateDir }); // 빈 폴더에서 처음부터
    this.#emitState();
    return { stage: this.stage() };
  }

  // ---- 신원(열쇠) ----

  // words가 있으면 복원, 없으면 새로 만들고 12단어를 한 번 돌려준다.
  async setupIdentity({ displayName, words } = {}) {
    this.#needSession();
    const hasWords = Array.isArray(words) ? words.length > 0 : !!String(words || '').trim();
    let created = null;
    if (hasWords) {
      await this.identity.restore(words);
      const profile = await this.identity.fetchProfile();
      if (!profile) await this.#registerProfile(displayName); // 새 계정에 옛 열쇠를 되살린 경우
      else if (displayName && displayName !== profile.display_name) await this.identity.rename(displayName);
      this.displayName = (displayName || profile?.display_name || this.displayName) ?? null;
    } else {
      const name = String(displayName || '').trim();
      if (!name) throw new Error('display name required');
      created = await this.identity.create(name);
      this.displayName = name;
    }
    this.keyMismatch = false; // 복원·새로 만들기가 끝났으면 서버와 다시 맞다
    await this.#saveSettings({ displayName: this.displayName });
    await this.#goLive();
    this.#emitState();
    return created ? { words: created } : {};
  }

  // Identity.restore는 profiles 행을 만들지 않는다 — 없으면 여기서 한 번 등록한다.
  async #registerProfile(displayName) {
    const name = String(displayName || '').trim();
    if (!name) throw new Error('display name required');
    await this.supa.insert('profiles', {
      id: this.session.user.id,
      display_name: name,
      public_key: b64.enc(this.identity.publicRaw),
      key_version: this.identity.keyVersion || 1,
    }, { returning: 'minimal' });
  }

  async resetIdentity({ displayName } = {}) {
    this.#needSession();
    const name = String(displayName || this.displayName || '').trim();
    if (!name) throw new Error('display name required');
    const words = await this.identity.reset(name);
    this.displayName = name;
    this.keyMismatch = false; // 새 열쇠를 서버에 올린 뒤라 다시 맞다
    await this.#saveSettings({ displayName: name });
    await this.#goLive();
    this.#emitState();
    return { words };
  }

  async mnemonic() {
    this.#needHub();
    return { words: await this.identity.mnemonic() };
  }

  // 이름만 바꾼다 — 열쇠·지문은 그대로다(열쇠 재설정과 다른 길).
  async rename(displayName) {
    this.#needSession();
    const name = String(displayName ?? '').trim();
    if (!name) throw new Error('display name required');
    if ([...name].length > NAME_MAX) throw new Error('display name too long');
    await this.identity.rename(name);
    this.displayName = name;
    await this.#saveSettings({ displayName: name });
    this.#emitState();
    return { displayName: name };
  }

  // ---- 설정 ----

  async #saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await writeJson(path.join(this.stateDir, 'settings.json'), this.settings);
  }

  async setNotifyMuted(muted) {
    await this.#saveSettings({ notifyMuted: !!muted });
    this.#emitState();
    return this.settings.notifyMuted;
  }

  // 허브를 바꾸면 그 계정은 남의 서버 것이므로 먼저 로그아웃하고 처음부터 다시 시작한다.
  async setHub({ url, anonKey }) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    const key = String(anonKey || '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(u) || !key) throw new Error('bad hub url or key');
    this.messages?.stop();
    try { if (this.session?.user) await this.session.logout(); } catch (e) { this.log(`logout: ${e.message}`); }
    await this.#saveSettings({ hub: { url: u, anonKey: key } });
    await this.init({ stateDir: this.stateDir });
    this.#emitState();
    return { stage: this.stage() };
  }

  settingsView() {
    return {
      notifyMuted: !!this.settings.notifyMuted,
      hub: { url: this.hubConf?.url ?? null, custom: this.hubCustom },
    };
  }

  async shutdown() {
    this.messages?.stop();
    this.#listeners = [];
  }
}
