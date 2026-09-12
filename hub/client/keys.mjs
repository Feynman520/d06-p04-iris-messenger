// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 12단어(BIP39) ↔ 엔트로피, X25519 열쇠 유도, 지문. Node 내장 crypto 만 쓴다.
import crypto from 'node:crypto';
import { WORDS } from './words.mjs';
export const FP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
export const b64 = { enc: (b) => Buffer.from(b).toString('base64'), dec: (s) => Buffer.from(String(s), 'base64') };
export function generateEntropy() { return crypto.randomBytes(16); }
const toBits = (buf) => [...buf].map(b => b.toString(2).padStart(8, '0')).join('');
export function entropyToMnemonic(entropy) {
  if (entropy.length !== 16) throw new Error('entropy must be 16 bytes');
  const cs = toBits(crypto.createHash('sha256').update(entropy).digest()).slice(0, 4);
  const bits = toBits(entropy) + cs; const out = [];
  for (let i = 0; i < 12; i++) out.push(WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  return out;
}
export function mnemonicToEntropy(words) {
  const list = (Array.isArray(words) ? words.join(' ') : String(words)).toLowerCase().trim().split(/\s+/);
  if (list.length !== 12) throw new Error('bad mnemonic');
  let bits = '';
  for (const w of list) { const i = WORDS.indexOf(w); if (i < 0) throw new Error('bad mnemonic'); bits += i.toString(2).padStart(11, '0'); }
  const ent = Buffer.from(bits.slice(0, 128).match(/.{8}/g).map(b => parseInt(b, 2)));
  const cs = toBits(crypto.createHash('sha256').update(ent).digest()).slice(0, 4);
  if (cs !== bits.slice(128)) throw new Error('bad mnemonic');
  return ent;
}
export function x25519PrivateKey(raw) { return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: 'der', type: 'pkcs8' }); }
export function x25519PublicKey(raw) { return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw]), format: 'der', type: 'spki' }); }
export function deriveKeyPair(entropy) {
  const privateRaw = Buffer.from(crypto.hkdfSync('sha256', entropy, 'iris-messenger', 'x25519-v1', 32));
  const publicRaw = Buffer.from(crypto.createPublicKey(x25519PrivateKey(privateRaw)).export({ type: 'spki', format: 'der' }).subarray(12));
  return { privateRaw, publicRaw };
}
export function fingerprint(publicRaw) {
  const bits = toBits(crypto.createHash('sha256').update(publicRaw).digest()).slice(0, 40);
  let s = ''; for (let i = 0; i < 8; i++) s += FP_ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return s;
}
