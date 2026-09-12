// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 신원: 12단어(BIP39) 니모닉으로 유도한 X25519 열쇠쌍을 keys.bin(DPAPI)에 보관하고
// 서버 profiles(공개키·표시이름·열쇠버전)와 맞춘다. 개인키는 로컬을 떠나지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { protect, unprotect } from './dpapi.mjs';
import { writeFileAtomic } from './store.mjs';
import { generateEntropy, entropyToMnemonic, mnemonicToEntropy, deriveKeyPair, fingerprint as fingerprintOf, b64 } from './keys.mjs';

const defaultDpapi = { protect, unprotect };

export class Identity {
  #stateDir;
  #supa;
  #dpapi;
  #entropy = null;
  #keyVersion = 0;
  #keys = null;

  constructor({ stateDir, supa, dpapi = defaultDpapi }) {
    this.#stateDir = stateDir;
    this.#supa = supa;
    this.#dpapi = dpapi;
  }

  get #keysFile() {
    return path.join(this.#stateDir, 'keys.bin');
  }

  get publicRaw() {
    return this.#keys?.publicRaw ?? null;
  }

  get privateRaw() {
    return this.#keys?.privateRaw ?? null;
  }

  get fingerprint() {
    return this.#keys ? fingerprintOf(this.#keys.publicRaw) : null;
  }

  get keyVersion() {
    return this.#keyVersion || null;
  }

  #uid() {
    const id = this.#supa.session?.user?.id;
    if (!id) throw new Error('no session');
    return id;
  }

  async #persist() {
    const obj = { entropy: b64.enc(this.#entropy), key_version: this.#keyVersion };
    const enc = await this.#dpapi.protect(Buffer.from(JSON.stringify(obj), 'utf8'));
    await writeFileAtomic(this.#keysFile, enc);
  }

  async load() {
    let enc;
    try {
      enc = await fs.readFile(this.#keysFile);
    } catch {
      return false;
    }
    try {
      const dec = await this.#dpapi.unprotect(enc);
      const obj = JSON.parse(dec.toString('utf8'));
      this.#entropy = b64.dec(obj.entropy);
      this.#keyVersion = obj.key_version;
      this.#keys = deriveKeyPair(this.#entropy);
      return true;
    } catch {
      return false;
    }
  }

  async fetchProfile() {
    const uid = this.#uid();
    const rows = await this.#supa.select('profiles', `id=eq.${uid}&select=display_name,public_key,key_version`);
    return rows?.[0] ?? null;
  }

  // 새 엔트로피로 열쇠를 만들어 keys.bin에 저장하고, profiles를 없으면 insert / 있으면 update(key_version+1)한다.
  async #mintKeypair(displayName, existing) {
    this.#entropy = generateEntropy();
    this.#keyVersion = existing ? existing.key_version + 1 : 1;
    this.#keys = deriveKeyPair(this.#entropy);
    await this.#persist();
    const uid = this.#uid();
    const patch = { display_name: displayName, public_key: b64.enc(this.#keys.publicRaw), key_version: this.#keyVersion };
    if (existing) await this.#supa.update('profiles', `id=eq.${uid}`, patch);
    else await this.#supa.insert('profiles', { id: uid, ...patch });
    return entropyToMnemonic(this.#entropy);
  }

  async create(displayName) {
    const existing = await this.fetchProfile();
    return this.#mintKeypair(displayName, existing);
  }

  async reset(displayName) {
    const existing = await this.fetchProfile();
    return this.#mintKeypair(displayName, existing);
  }

  async restore(words) {
    const entropy = mnemonicToEntropy(words);
    const keys = deriveKeyPair(entropy);
    const profile = await this.fetchProfile();
    if (profile && profile.public_key !== b64.enc(keys.publicRaw)) throw new Error('mismatch');
    this.#entropy = entropy;
    this.#keys = keys;
    this.#keyVersion = profile ? profile.key_version : 1;
    await this.#persist();
  }

  async rename(displayName) {
    const uid = this.#uid();
    await this.#supa.update('profiles', `id=eq.${uid}`, { display_name: displayName });
  }

  async mnemonic() {
    if (!this.#entropy) throw new Error('not loaded');
    return entropyToMnemonic(this.#entropy);
  }
}
