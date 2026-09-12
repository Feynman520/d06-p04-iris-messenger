// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 봉투 암호화(ECIES 계열): X25519 2회(일회용·발신자) → HKDF-SHA256 → AES-256-GCM. 파일은 무작위 대칭 열쇠로 따로 잠근다.
import crypto from 'node:crypto';
import { x25519PrivateKey, x25519PublicKey, b64 } from './keys.mjs';
export const ENVELOPE_VERSION = 1;
const INFO = 'iris-messenger-envelope-v1';
const dh = (privRaw, pubRaw) => crypto.diffieHellman({ privateKey: x25519PrivateKey(privRaw), publicKey: x25519PublicKey(pubRaw) });
function deriveKey(s1, s2, ephPub, senderPub, recipientPub) { return Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([s1, s2]), Buffer.concat([ephPub, senderPub, recipientPub]), INFO, 32)); }
export function seal({ senderPrivateRaw, senderPublicRaw, recipientPublicRaw, envelope }) {
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = Buffer.from(eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
  const ephPrivRaw = Buffer.from(eph.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16));
  const key = deriveKey(dh(ephPrivRaw, recipientPublicRaw), dh(senderPrivateRaw, recipientPublicRaw), ephPub, senderPublicRaw, recipientPublicRaw);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce); c.setAAD(Buffer.concat([Buffer.from([ENVELOPE_VERSION]), ephPub, senderPublicRaw]));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(envelope), 'utf8')), c.final()]);
  return b64.enc(Buffer.concat([Buffer.from([ENVELOPE_VERSION]), ephPub, nonce, ct, c.getAuthTag()]));
}
export function open({ recipientPrivateRaw, recipientPublicRaw, senderPublicRaw, blob }) {
  try {
    const buf = b64.dec(blob); if (buf[0] !== ENVELOPE_VERSION || buf.length < 1 + 32 + 12 + 16) throw new Error('format');
    const ephPub = buf.subarray(1, 33), nonce = buf.subarray(33, 45), tag = buf.subarray(buf.length - 16), ct = buf.subarray(45, buf.length - 16);
    const key = deriveKey(dh(recipientPrivateRaw, ephPub), dh(recipientPrivateRaw, senderPublicRaw), ephPub, senderPublicRaw, recipientPublicRaw);
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce); d.setAAD(Buffer.concat([Buffer.from([ENVELOPE_VERSION]), ephPub, senderPublicRaw])); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  } catch { throw new Error('cannot open'); }
}
export function sealFile(data) {
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { data: Buffer.concat([nonce, ct, c.getAuthTag()]), key: b64.enc(key) };
}
export function openFile(sealed, key) {
  try {
    if (!Buffer.isBuffer(sealed) || sealed.length < 12 + 16) throw new Error('cannot open file'); // 논스+태그 자리도 없는 입력(open()과 같은 최소 길이 가드)
    const k = b64.dec(key); const nonce = sealed.subarray(0, 12), tag = sealed.subarray(sealed.length - 16), ct = sealed.subarray(12, sealed.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', k, nonce); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch { throw new Error('cannot open file'); }
}
