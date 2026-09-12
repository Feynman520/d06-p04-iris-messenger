// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// V3 verify-rls: 가짜 사용자 A·B·C 로 RLS·함수 경계를 확인한다. 정책을 바꿀 때마다 실행. 사용: npm run verify:rls
import { adminCreateUser, adminDeleteUser, adminSignIn, asUser, loadHub } from './lib/admin.mjs';
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}`); };
const ts = Date.now(); const users = [];
const pk = (ch) => Buffer.alloc(32, ch).toString('base64'); // 44자 base64 (형식만)
const hub = loadHub();
try {
  const mk = async (n) => { const email = `rls-${n}-${ts}@example.com`; const { id } = await adminCreateUser(email); const s = await adminSignIn(email); users.push({ id, email, token: s.access_token, n }); return users.at(-1); };
  const A = await mk('a'), B = await mk('b'), C = await mk('c');
  const rpc = (u, fn, args) => asUser(u.token, 'POST', `/rest/v1/rpc/${fn}`, args || {});
  for (const u of [A, B, C]) { const r = await asUser(u.token, 'POST', '/rest/v1/profiles', { id: u.id, display_name: `User ${u.n}`, public_key: pk(u.n.charCodeAt(0)) }); ok(r.status === 201, `profiles insert self (${u.n})`); }
  let r = await asUser(A.token, 'POST', '/rest/v1/profiles', { id: B.id, display_name: 'x', public_key: pk(1) }); ok(r.status >= 400, 'profiles insert as other → rejected');
  r = await asUser(A.token, 'GET', `/rest/v1/profiles?id=eq.${B.id}`); ok(r.status === 200 && r.body.length === 0, 'profiles: stranger not visible (0 rows)');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: A.id, recipient: B.id, kind: 'text', body: 'x' }); ok(r.status >= 400, 'messages insert to non-contact → rejected');
  r = await rpc(A, 'create_invite'); ok(r.status === 200 && /^[A-HJ-NP-Z2-9]{8}$/.test(r.body), 'create_invite → 8 chars'); const code = r.body;
  r = await rpc(A, 'lookup_invite', { p_code: code }); ok(r.status === 200 && r.body.length === 0, 'lookup_invite: owner cannot look up own code');
  r = await rpc(B, 'lookup_invite', { p_code: code.toLowerCase() }); ok(r.status === 200 && r.body[0]?.display_name === 'User a' && r.body[0]?.public_key === pk(97), 'lookup_invite: B sees A name+key (case-insensitive)');
  r = await rpc(B, 'accept_invite', { p_code: code }); ok(r.status === 200 && r.body[0]?.status === 'pending', 'accept_invite → pending');
  r = await rpc(C, 'accept_invite', { p_code: code }); ok(r.status === 200 && r.body[0]?.status === 'invalid', 'accept_invite: used code rejected');
  // rate limit (0002): lookup_invite·accept_invite 는 합쳐서 분당 10회. C 를 이 검사 뒤로는 다른 초대 검사에 쓰지 않는다.
  for (let i = 0; i < 10; i++) await rpc(C, 'lookup_invite', { p_code: 'ZZZZZZZZ' });
  r = await rpc(C, 'lookup_invite', { p_code: 'ZZZZZZZZ' }); ok(r.status >= 400, 'lookup_invite: rate limited after 10+ attempts/min');
  r = await rpc(C, 'accept_invite', { p_code: 'ZZZZZZZZ' }); ok(r.status === 200 && r.body[0]?.status === 'rate_limited', 'accept_invite: rate limited');
  r = await asUser(A.token, 'GET', `/rest/v1/profiles?id=eq.${B.id}`); ok(r.status === 200 && r.body.length === 1, 'profiles: pending contact visible to owner');
  r = await asUser(B.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: B.id, recipient: A.id, kind: 'text', body: 'x' }); ok(r.status >= 400, 'messages: pending contact cannot send');
  r = await rpc(B, 'respond_contact', { p_other: A.id, p_action: 'accept' }); ok(r.status >= 400, 'respond_contact: requester cannot self-accept');
  r = await rpc(A, 'respond_contact', { p_other: B.id, p_action: 'accept' }); ok(r.status === 200 && r.body === 'accepted', 'respond_contact: owner accepts');
  const cid = crypto.randomUUID();
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: cid, sender: A.id, recipient: B.id, kind: 'text', body: 'ciphertext' }); ok(r.status === 201, 'messages: accepted contact can send');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: cid, sender: A.id, recipient: B.id, kind: 'text', body: 'ciphertext' }); ok(r.status === 409, 'messages: duplicate client_id → 409 (V7)');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: B.id, recipient: A.id, kind: 'text', body: 'x' }); ok(r.status >= 400, 'messages: cannot forge sender');
  r = await asUser(C.token, 'GET', `/rest/v1/messages?recipient=eq.${B.id}`); ok(r.status === 200 && r.body.length === 0, 'messages: third party sees 0 rows');
  r = await asUser(B.token, 'GET', `/rest/v1/messages?recipient=eq.${B.id}&delivered_at=is.null`); ok(r.status === 200 && r.body.length === 1, 'messages: recipient sees undelivered 1 row');
  const mid = r.body[0]?.id;
  r = await asUser(A.token, 'PATCH', `/rest/v1/messages?id=eq.${mid}`, { delivered_at: new Date().toISOString() }); ok(r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0), 'messages: direct PATCH not allowed');
  r = await rpc(B, 'mark_delivered', { p_ids: [mid] }); ok(r.status === 200 && r.body === 1, 'mark_delivered → 1');
  r = await rpc(A, 'mark_delivered', { p_ids: [mid] }); ok(r.status === 200 && r.body === 0, 'mark_delivered by sender → 0');
  r = await asUser(C.token, 'GET', `/rest/v1/contacts`); ok(r.status === 200 && r.body.length === 0, 'contacts: third party 0 rows');
  r = await rpc(B, 'respond_contact', { p_other: A.id, p_action: 'block' }); ok(r.status === 200 && r.body === 'blocked', 'block');
  r = await rpc(A, 'respond_contact', { p_other: B.id, p_action: 'block' }); ok(r.status >= 400, 'respond_contact: block bypass by the blocked party rejected');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: A.id, recipient: B.id, kind: 'text', body: 'x' }); ok(r.status >= 400, 'messages: blocked → rejected');
  r = await rpc(A, 'respond_contact', { p_other: B.id, p_action: 'unblock' }); ok(r.status >= 400, 'unblock by the other side → rejected');
  r = await rpc(B, 'respond_contact', { p_other: A.id, p_action: 'unblock' }); ok(r.status === 200 && r.body === 'accepted', 'unblock by blocker → accepted');
  // file_path 소유 검사 (0002): 남의 폴더 지정, file 인데 file_path 없음, text 인데 file_path 있음 — 전부 거부
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: A.id, recipient: B.id, kind: 'file', body: 'c', file_path: `${B.id}/${crypto.randomUUID()}` }); ok(r.status >= 400, 'messages: file_path in other user folder rejected');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: A.id, recipient: B.id, kind: 'file', body: 'c' }); ok(r.status >= 400, 'messages: file kind without file_path rejected (constraint)');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: A.id, recipient: B.id, kind: 'text', body: 'c', file_path: `${A.id}/${crypto.randomUUID()}` }); ok(r.status >= 400, 'messages: text kind with file_path rejected (constraint)');
  // storage: A 가 자기 폴더에만 올릴 수 있고, B 는 메시지가 가리키는 파일만 읽는다
  const up = async (u, p) => { const rr = await fetch(`${hub.url}/storage/v1/object/files/${p}`, { method: 'POST', headers: { apikey: hub.anonKey, Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('blob') }); return rr.status; };
  const fid = crypto.randomUUID();
  ok((await up(A, `${A.id}/${fid}`)) === 200, 'storage: upload to own folder');
  ok((await up(A, `${B.id}/${fid}`)) >= 400, 'storage: upload to other folder rejected');
  const dl = async (u, p) => { const rr = await fetch(`${hub.url}/storage/v1/object/files/${p}`, { headers: { apikey: hub.anonKey, Authorization: `Bearer ${u.token}` } }); return rr.status; };
  ok((await dl(B, `${A.id}/${fid}`)) >= 400, 'storage: recipient cannot read before message row');
  r = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: fid, sender: A.id, recipient: B.id, kind: 'file', body: 'c', file_path: `${A.id}/${fid}` }); ok(r.status === 201, 'messages: file row');
  ok((await dl(B, `${A.id}/${fid}`)) === 200, 'storage: recipient reads after message row');
  ok((await dl(C, `${A.id}/${fid}`)) >= 400, 'storage: third party cannot read');
  r = await rpc(C, 'delete_me'); ok(r.status === 200 || r.status === 204, 'delete_me (C)'); users.splice(users.findIndex(u => u.n === 'c'), 1);
  r = await asUser(A.token, 'GET', '/rest/v1/meta?key=eq.schema_version'); ok(r.status === 200 && r.body[0]?.value === '1', 'meta readable');
  r = await asUser(A.token, 'GET', '/rest/v1/meta?key=eq.hardening'); ok(r.status === 200 && r.body[0]?.value === '0002', 'meta: hardening = 0002');
} finally {
  for (const u of users) { try { await adminDeleteUser(u.id); } catch (e) { console.log(`cleanup ${u.email}: ${e.message}`); } }
}
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
