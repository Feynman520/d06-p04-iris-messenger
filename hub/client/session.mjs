// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 로그인 세션: 이메일 OTP(또는 붙여넣은 매직링크) 인증, 토큰을 DPAPI로 auth.bin에 보관하고
// supa.onSession 갱신마다 다시 쓴다. 5회 연속 실패 시 잠금, 로그아웃·계정삭제 시 로컬 흔적을 지운다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { protect, unprotect } from './dpapi.mjs';
import { writeFileAtomic } from './store.mjs';

const defaultDpapi = { protect, unprotect };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILS = 5;

export class Session {
  #stateDir;
  #supa;
  #dpapi;
  #failCount = 0;
  #lastWrite = Promise.resolve();

  constructor({ stateDir, supa, dpapi = defaultDpapi }) {
    this.#stateDir = stateDir;
    this.#supa = supa;
    this.#dpapi = dpapi;
    supa.onSession((s) => {
      this.#lastWrite = this.#persist(s).catch(() => {});
    });
  }

  get #authFile() {
    return path.join(this.#stateDir, 'auth.bin');
  }

  get user() {
    const s = this.#supa.session;
    return s?.user ? { id: s.user.id, email: s.user.email } : null;
  }

  async #persist(s) {
    if (s) {
      const enc = await this.#dpapi.protect(Buffer.from(JSON.stringify(s), 'utf8'));
      await writeFileAtomic(this.#authFile, enc);
    } else {
      await fs.rm(this.#authFile, { force: true });
    }
  }

  async load() {
    let enc;
    try {
      enc = await fs.readFile(this.#authFile);
    } catch {
      return false;
    }
    let obj;
    try {
      const dec = await this.#dpapi.unprotect(enc);
      obj = JSON.parse(dec.toString('utf8'));
    } catch {
      await fs.rm(this.#authFile, { force: true });
      return false;
    }
    this.#supa.setSession(obj);
    try {
      await this.#supa.ensureFresh();
      await this.#lastWrite;
      return true;
    } catch (e) {
      if (e?.status === 401 || e?.status === 400 || e?.status === 403) {
        await fs.rm(this.#authFile, { force: true });
        return false;
      }
      throw e;
    }
  }

  async requestCode(email) {
    if (!EMAIL_RE.test(String(email))) throw new Error('bad email');
    this.#failCount = 0;
    return this.#supa.otpRequest(email);
  }

  async verifyCode(email, code) {
    if (this.#failCount >= MAX_FAILS) throw new Error('locked');
    const raw = String(code).trim();
    const isNumeric = /^\d{6}$/.test(raw);
    const isLink = /^https?:\/\//i.test(raw);
    if (!isNumeric && !isLink) throw new Error('bad code');
    try {
      const s = await this.#supa.otpVerify(email, raw);
      await this.#lastWrite;
      this.#failCount = 0;
      return { id: s.user.id, email: s.user.email };
    } catch (e) {
      this.#failCount += 1;
      throw e;
    }
  }

  async logout() {
    await this.#supa.logout();
    await this.#lastWrite;
    await fs.rm(this.#authFile, { force: true });
  }

  async deleteAccount() {
    await this.#supa.rpc('delete_me');
    let entries;
    try {
      entries = await fs.readdir(this.#stateDir);
    } catch {
      return;
    }
    await Promise.all(entries.map((name) => fs.rm(path.join(this.#stateDir, name), { recursive: true, force: true })));
  }
}
