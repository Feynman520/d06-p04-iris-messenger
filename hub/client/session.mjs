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
  #accountPaths;
  #failCount = 0;
  #lastWrite = Promise.resolve();

  // accountPaths(uid) → 탈퇴 때 지울 "이 계정만의" 경로 목록. 폴더 짜임새를 아는 쪽(App)이 넣어 준다.
  // 넣지 않으면 탈퇴는 로그인 정보(auth.bin)만 지운다 — 남의 계정 폴더를 짐작해서 지우지 않는다.
  constructor({ stateDir, supa, dpapi = defaultDpapi, accountPaths = null }) {
    this.#stateDir = stateDir;
    this.#supa = supa;
    this.#dpapi = dpapi;
    this.#accountPaths = accountPaths;
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
        // 파일만 지우면 메모리에는 죽은 세션이 남아 session.user 가 로그인한 것처럼 보인다 — 함께 비운다.
        this.#supa.setSession(null);
        await this.#lastWrite;
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

  // 탈퇴: 서버에서 계정을 지우고 이 PC에서는 **이 계정의 것만** 지운다.
  // 지우는 것 = 로그인 정보(auth.bin) + accountPaths(uid) 가 알려 준 이 계정의 폴더·파일.
  // 건드리지 않는 것 = 다른 계정의 폴더, 이 PC의 설정(settings.json).
  async deleteAccount() {
    const uid = this.#supa.session?.user?.id ?? null; // rpc 뒤에는 세션이 사라질 수 있어 먼저 집어 둔다
    await this.#supa.rpc('delete_me');
    await this.#lastWrite;
    await fs.rm(this.#authFile, { force: true });
    const targets = typeof this.#accountPaths === 'function' ? (this.#accountPaths(uid) || []) : [];
    for (const p of targets) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }
}
