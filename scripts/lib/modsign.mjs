// IRIS-Face · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// P02 IRIS-Face daemon/modsign.mjs 사본(2026-09-13). 바뀌면 P02가 정본.
// 모듈 zip의 매니페스트(파일별 SHA-256)와 Ed25519 서명. 공식 모듈 = 아래 공개 열쇠로 검증되는 서명(모듈 이름과 무관, 모든 공식 모듈 공용).
// 개인 열쇠는 운영자 secrets(`_agent\claude\secrets\iris-module-signing-<id>.key`)에만 있다. 열쇠 교체 절차 = P04 설계.md 조각 9 ⑧.
import crypto from 'node:crypto';

/** 공식 모듈 서명 공개 열쇠(여러 개 = 교체 이력). id 는 secrets 파일 이름의 날짜와 같다. */
export const OFFICIAL_PUBLIC_KEYS = [
  { id: '2026-09', pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADdA2dLZYGS1xtopCA8SLwXkslakn8pTFc8qjkv+auVw=
-----END PUBLIC KEY-----
` },
];
/** 유출·폐기된 열쇠 id. 이 열쇠로 서명된 모듈은 "폐기된 열쇠 ⚠"로 비공식 취급. */
export const REVOKED_KEY_IDS = [];

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** [{ name, data }] → 매니페스트 객체. manifest.json·manifest.sig 는 제외, 이름 오름차순. extra 는 source(커밋 해시) 등. */
export function buildManifest(files, extra = {}) {
  const list = files.filter(f => f.name !== 'manifest.json' && f.name !== 'manifest.sig').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { version: 1, files: Object.fromEntries(list.map(f => [f.name, sha256(f.data)])), ...extra };
}
export function signManifest(text, privatePem) { return crypto.sign(null, Buffer.from(text, 'utf8'), privatePem).toString('base64'); }
export function verifyManifest(text, sigB64, keys = OFFICIAL_PUBLIC_KEYS) {
  let sig; try { sig = Buffer.from(String(sigB64).trim(), 'base64'); } catch { return { ok: false }; }
  for (const k of keys) {
    try { if (crypto.verify(null, Buffer.from(text, 'utf8'), k.pem, sig)) return { ok: true, keyId: k.id, revoked: REVOKED_KEY_IDS.includes(k.id) }; } catch {}
  }
  return { ok: false };
}
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
