// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 응용 상태: Face가 준 state 폴더 하나에 Supa·Session·Identity·Contacts·Messages를 묶고
// 화면이 그릴 수 있는 한 덩어리 state()로 내놓는다. 화면(api.mjs)과 전선(index.mjs)은 이 class만 쓴다.
//
// 폴더 나누기: 로그인 정보(auth.bin)와 모듈 설정(settings.json)은 state 폴더 뿌리에 두고,
// 계정마다 달라지는 것(열쇠·연락처·편지·받은 파일·보낼 것)은 전부 `accounts\<사용자 번호>\` 아래에 둔다.
// 그래야 한 PC에서 계정을 갈아타도 서로의 자료가 섞이거나 지워지지 않는다.
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supa } from '../hub/client/supa.mjs';
import { Session } from '../hub/client/session.mjs';
import { Identity } from '../hub/client/identity.mjs';
import { Contacts } from '../hub/client/contacts.mjs';
import { b64 } from '../hub/client/keys.mjs';
import { readJson, writeJson, ensureDir } from '../hub/client/store.mjs';
import { Messages, TEXT_MAX, FILE_MAX, RISKY_EXT } from './messages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NAME_MAX = 40; // 표시 이름 글자 수 상한(화면·API가 같은 값을 쓴다)
// 계정 폴더가 생기기 전(0.1.0)의 자리 — 첫 로그인 때 통째로 계정 폴더로 옮긴다.
const LEGACY_NAMES = ['keys.bin', 'contacts.json', 'messages', 'files', 'outbox.json'];

// 단계(stage): nohub 허브 주소 없음 · out 로그인 전 · code 코드 입력 대기 · identity 열쇠 없음 · in 사용 가능
export class App {
  #listeners = [];
  #pendingEmail = null;

  constructor({ makeSupa, dpapi, log = () => {} } = {}) {
    this.log = log;
    this.dpapi = dpapi; // undefined면 Session·Identity가 실제 DPAPI를 쓴다
    this.makeSupa = makeSupa || ((conf) => new Supa({ ...conf, log }));
    this.stateDir = null;
    this.accountId = null;   // 지금 자료가 올라와 있는 계정(사용자 번호)
    this.accountDir = null;  // stateDir\accounts\<사용자 번호>
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
    this.profileMissing = false; // 이 PC에는 열쇠가 있는데 서버에는 내 프로필 줄이 없다
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
    this.profileMissing = false;
    this.#pendingEmail = null;
    // 새로 시작하는 길이므로 계정 자료도 새 Supa 에 맞춰 다시 올린다(옛 Supa 를 쥔 채로 남지 않게).
    this.accountId = null;
    this.accountDir = null;
    this.identity = this.contacts = this.messages = null;

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

    this.session = new Session({ stateDir, supa: this.supa, dpapi: this.dpapi });

    // 여기까지는 전부 로컬 파일 읽기다 — 로그인 전에는 네트워크를 만지지 않는다.
    try { await this.session.load(); } catch (e) { this.log(`session.load: ${e.message}`); }
    await this.#useAccount(this.session?.user?.id ?? null);

    await this.#goLive();
    return this;
  }

  // 로그인한 계정의 자료를 올린다. 계정이 바뀌면 옛 계정의 것은 손대지 않고(폴더에 그대로 남는다)
  // 메모리에서만 내려놓고 새 계정 폴더로 다시 읽는다.
  async #useAccount(uid) {
    if (this.accountId === uid && this.identity) return;
    this.messages?.stop();
    this.accountId = uid ?? null;
    this.accountDir = null;
    this.identity = this.contacts = this.messages = null;
    this.keyMismatch = false;
    this.profileMissing = false;
    if (!uid || !this.supa) return;

    const dir = path.join(this.stateDir, 'accounts', String(uid));
    await this.#migrateLegacy(dir);
    await ensureDir(dir);
    this.accountDir = dir;

    const me = () => this.session?.user?.id ?? null;
    this.identity = new Identity({ stateDir: dir, supa: this.supa, dpapi: this.dpapi });
    this.contacts = new Contacts({ stateDir: dir, supa: this.supa, identity: this.identity, me });
    this.messages = new Messages({
      stateDir: dir,
      supa: this.supa,
      identity: this.identity,
      contacts: this.contacts,
      me,
      onEvent: (e) => this.#emit(e),
      log: this.log,
    });
    await this.identity.load();
    await this.contacts.load();
    await this.messages.load();
  }

  // 0.1.0에서 올라온 PC: 계정 폴더가 아직 없고 뿌리에 옛 파일이 있으면 그대로 옮겨 준다(복사가 아니라 이동).
  async #migrateLegacy(dir) {
    if (fsSync.existsSync(dir)) return;
    const found = LEGACY_NAMES.filter((n) => fsSync.existsSync(path.join(this.stateDir, n)));
    if (!found.length) return;
    await ensureDir(dir);
    for (const name of found) {
      try {
        await fsp.rename(path.join(this.stateDir, name), path.join(dir, name));
      } catch (e) {
        this.log(`migrate ${name}: ${e.message}`); // 옮기지 못한 것은 그 자리에 두고 새로 시작한다
      }
    }
    this.log(`migrated ${found.length} legacy item(s) into accounts/${path.basename(dir)}`);
  }

  // 로그인 + 열쇠가 모두 갖춰진 뒤에만: 허브 판 확인 → 연락처 맞추기 → 편지 연결.
  async #goLive() {
    this.profileMissing = false;
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
      // 열쇠는 이 PC에 있는데 서버에 프로필 줄이 아예 없는 경우(탈퇴 뒤 재가입, 다른 허브의 계정 등):
      // 상대가 나를 찾을 수도, 내가 초대 코드를 만들 수도 없다 — 신원 화면으로 돌려 등록·복원하게 한다.
      this.profileMissing = !profile;
      // 서버의 이름이 정본 — 다른 기기에서 바꿨거나 다른 계정으로 갈아탄 경우를 맞춘다.
      const name = profile?.display_name || null;
      if (!this.keyMismatch && name && name !== this.displayName) {
        this.displayName = name;
        await this.#saveSettings({ displayName: name });
      }
    } catch (e) {
      this.log(`profile: ${e.message}`); // 오프라인이면 마지막으로 알던 이름·판정을 그대로 쓴다
    }
    if (this.hubMismatch || this.keyMismatch || this.profileMissing) return; // 맞지 않는 허브·열쇠에는 연결하지 않는다
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
    if (!this.identity?.publicRaw || this.keyMismatch || this.profileMissing) return 'identity';
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
      profileMissing: !!this.profileMissing,
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
    // 지난번과 다른 계정으로 들어왔으면 그 계정의 폴더로 통째로 갈아 끼운다(옛 계정 자료는 그대로 남는다).
    await this.#useAccount(this.session.user?.id ?? null);
    await this.#goLive();
    this.#emitState();
    return { stage: this.stage() };
  }

  // 로그인 절차(login1·login2)를 거치지 않고 바깥에서 세션이 주입된 경우(라이브 검사 등)
  // 그 계정의 폴더를 올려 준다 — login2 가 하는 일 가운데 세션 확인만 뺀 것.
  async adoptSession() {
    this.#needHub();
    await this.#useAccount(this.session?.user?.id ?? null);
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
    this.profileMissing = false;
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

  // 이 PC에는 열쇠가 있는데 서버에만 프로필 줄이 없을 때(profileMissing): 지금 열쇠 그대로 한 줄을 만든다.
  // 열쇠·지문은 바뀌지 않으므로 이미 나를 고정(pin)해 둔 상대에게는 아무 경고도 가지 않는다.
  async registerExisting(displayName) {
    this.#needSession();
    if (!this.identity?.publicRaw) throw new Error('no key on this pc');
    const name = String(displayName || this.displayName || '').trim();
    if (!name) throw new Error('display name required');
    if ([...name].length > NAME_MAX) throw new Error('display name too long');
    await this.#registerProfile(name);
    this.displayName = name;
    this.profileMissing = false;
    await this.#saveSettings({ displayName: name });
    await this.#goLive();
    this.#emitState();
    return { displayName: name };
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
