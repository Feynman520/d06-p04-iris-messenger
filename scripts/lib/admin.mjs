// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 라이브 검사·운영 전용 관리자 도우미(service role). 모듈 코드에서 절대 import 하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../../hub/server/deploy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function loadHub() { return JSON.parse(fs.readFileSync(path.join(root, 'module', 'hub.json'), 'utf8')); }
export function loadSecrets() { return readEnv(path.join(process.env.CLAUDE_CONFIG_DIR || 'C:/IRIS/_agent/claude', 'secrets', '.env')); }
const hub = loadHub();
const SR = () => { const k = loadSecrets().SUPABASE_SERVICE_ROLE_KEY_IRIS_MESSENGER; if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY_IRIS_MESSENGER missing'); return k; };
async function adm(method, p, body) {
  const r = await fetch(`${hub.url}${p}`, { method, headers: { apikey: SR(), Authorization: `Bearer ${SR()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`); return t ? JSON.parse(t) : null;
}
export async function adminCreateUser(email) { const u = await adm('POST', '/auth/v1/admin/users', { email, email_confirm: true }); return { id: u.id }; }
export async function adminDeleteUser(id) { return adm('DELETE', `/auth/v1/admin/users/${id}`); }
export async function adminSignIn(email) {
  const link = await adm('POST', '/auth/v1/admin/generate_link', { type: 'magiclink', email });
  const otp = link.email_otp || link.properties?.email_otp; if (!otp) throw new Error(`generate_link gave no email_otp (keys: ${Object.keys(link).join(',')})`);
  const r = await fetch(`${hub.url}/auth/v1/verify`, { method: 'POST', headers: { apikey: hub.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', email, token: otp }) });
  const s = await r.json(); if (!r.ok) throw new Error(`verify → ${r.status} ${JSON.stringify(s).slice(0, 300)}`); return s;
}
/** 사용자 토큰으로 PostgREST 호출(검사용 최소형) */
export async function asUser(token, method, p, body, extraHeaders = {}) {
  const r = await fetch(`${hub.url}${p}`, { method, headers: { apikey: hub.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
