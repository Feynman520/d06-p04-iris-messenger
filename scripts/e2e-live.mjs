// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 라이브 E2E: 실 허브(Supabase)에 진짜 계정 두 개(A·B)를 만들고 실제 App/Messages 코드로
// 글·파일을 주고받는다. V6(끊긴 사이의 편지는 다시 붙으면 메워진다)·V7(같은 client_id 재전송은 409)까지 확인.
// 로그인 단계(이메일 OTP)만 관리자 API로 건너뛰고, 그 뒤는 화면이 부르는 것과 똑같은 길을 쓴다.
// 사용: npm run verify:e2e   — 끝나면 finally 에서 계정·Storage 객체·임시 폴더를 반드시 지운다.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { App } from '../module/app.mjs';
import { adminCreateUser, adminDeleteUser, adminSignIn, asUser, loadHub, serviceRoleKey } from './lib/admin.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t0) => `${Date.now() - t0}ms`;

const hub = loadHub();
const ts = Date.now();
const users = [];      // [{ id, email }] — finally 에서 지운다
const people = [];     // 만들어진 App 묶음(정리 때 연결을 끊는다)
const dirs = [];       // 임시 state 폴더
const objects = [];    // 지워야 할 Storage 객체 경로
const timings = [];    // ['이름 1234ms', …] — 보고서에 붙인다

// 서비스 롤 열쇠는 admin.mjs 를 통해서만 얻고, 어디에도 찍지 않는다.
async function adminDeleteObjects(prefixes) {
  if (!prefixes.length) return 0;
  const key = serviceRoleKey();
  const r = await fetch(`${hub.url}/storage/v1/object/files`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`storage delete → ${r.status} ${t.slice(0, 200)}`);
  return prefixes.length;
}

// 한 사람분: 임시 state 폴더 + 진짜 App + (OTP 대신) 관리자 세션 주입 + 열쇠 만들기.
async function makePerson(tag, displayName) {
  const email = `e2e-${tag}-${ts}@example.com`;
  const { id } = await adminCreateUser(email);
  users.push({ id, email, tag });
  const s = await adminSignIn(email);            // 세션은 통째로 주입만 하고 내용은 찍지 않는다
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `iris-e2e-${tag}-`));
  dirs.push(stateDir);
  const app = new App({ log: () => {} });        // dpapi 주입 없음 = 실제 Windows DPAPI 경로
  await app.init({ stateDir });
  if (app.stage() !== 'out') throw new Error(`${tag}: stage before login = ${app.stage()}`);
  app.supa.setSession({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: Number(s.expires_at) || Math.floor(Date.now() / 1000) + Number(s.expires_in || 3600),
    user: { id: s.user.id, email: s.user.email },
  });
  await app.adoptSession();                      // 계정 폴더(state\accounts\<번호>)를 올린다
  await app.setupIdentity({ displayName });      // 12단어를 돌려주지만 절대 출력하지 않는다
  const person = { tag, id, email, token: s.access_token, stateDir, app, m: app.messages, c: app.contacts };
  people.push(person);
  return person;
}

// 편지가 도착할 때까지 기록을 200ms 마다 들여다본다.
// 도어벨(웹소켓)이 빠른 길, gapFill 이 안전망 — 어느 길로 왔는지 함께 돌려준다.
async function waitItem(person, peer, match, { timeout = 10000, manualGapAt = 5000 } = {}) {
  const t0 = Date.now();
  let manual = false;
  for (;;) {
    const item = person.m.history(peer).find(match);
    if (item) return { item, ms: Date.now() - t0, path: manual ? 'gapFill(manual)' : 'auto', conn: person.m.connection };
    const el = Date.now() - t0;
    if (el >= timeout) return { item: null, ms: el, path: manual ? 'gapFill(manual)' : 'none', conn: person.m.connection };
    if (!manual && el >= manualGapAt) { manual = true; try { await person.m.gapFill(); } catch { /* 안전망도 실패하면 그냥 기다린다 */ } }
    await sleep(200);
  }
}

const textIs = (t) => (i) => i.dir === 'in' && i.kind === 'text' && i.text === t;
const T0 = Date.now();

try {
  // ---- ① 두 사람 만들기 ----
  let t = Date.now();
  const [A, B] = [await makePerson('a', 'E2E Alice'), await makePerson('b', 'E2E Bob')];
  timings.push(`setup(두 계정·열쇠) ${ms(t)}`);
  ok(A.app.stage() === 'in' && B.app.stage() === 'in', 'both apps reach stage "in"', `A=${A.app.stage()} B=${B.app.stage()}`);
  ok(!!A.app.state().fingerprint && !!B.app.state().fingerprint, 'both have a key fingerprint');
  ok(A.app.state().hubMismatch === null, 'hub schema matches the module');

  // ---- ② 연락처 상호 수락 ----
  t = Date.now();
  const code = await A.c.createInvite();
  ok(/^IRIS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), 'A createInvite → IRIS-XXXX-XXXX-XXXX');
  const acc = await B.c.acceptInvite(code);
  ok(acc.id === A.id && acc.displayName === 'E2E Alice', 'B acceptInvite → A의 이름·지문');
  await A.c.sync();
  ok(A.c.get(B.id)?.status === 'pending_in', 'A sees B as pending_in');
  ok((await A.c.respond(B.id, 'accept')) === 'accepted', 'A respond(accept) → accepted');
  await B.c.sync();
  ok(A.c.get(B.id)?.status === 'accepted' && B.c.get(A.id)?.status === 'accepted', 'both sides accepted');
  ok(!!A.c.publicKeyOf(B.id) && !!B.c.publicKeyOf(A.id), 'both pinned the other public key');
  timings.push(`연락처 상호 수락 ${ms(t)}`);

  // 'online' 은 서버가 구독(postgres_changes)을 받아들였다고 답한 뒤에만 켜진다(2026-09-13 수정).
  // 그래서 여기서는 그 신호만 기다리면 되고, 따로 뜸을 들이지 않는다 — 바로 다음 편지가 도어벨로 와야 한다.
  const tConn = Date.now();
  for (let i = 0; i < 25 && !(A.m.connection === 'online' && B.m.connection === 'online'); i += 1) await sleep(200);
  const connAtStart = { a: A.m.connection, b: B.m.connection };
  console.log(`INFO realtime after setup: A=${connAtStart.a} B=${connAtStart.b} (after ${ms(tConn)})`);

  // ---- ③ 글 왕복 ----
  t = Date.now();
  const TXT_AB = 'e2e-text-a-to-b';
  const outAB = await A.m.sendText(B.id, TXT_AB);
  ok(outAB.status === 'sent', 'A→B sendText → status sent', outAB.error || '');
  const gotAB = await waitItem(B, A.id, textIs(TXT_AB));
  ok(gotAB.item?.status === 'received', 'B receives A text within 10s', `${gotAB.ms}ms via ${gotAB.path} (conn=${gotAB.conn})`);
  timings.push(`A→B 글 도착 ${gotAB.ms}ms via ${gotAB.path}`);

  const TXT_BA = 'e2e-text-b-to-a';
  const outBA = await B.m.sendText(A.id, TXT_BA);
  ok(outBA.status === 'sent', 'B→A sendText → status sent', outBA.error || '');
  const gotBA = await waitItem(A, B.id, textIs(TXT_BA));
  ok(gotBA.item?.status === 'received', 'A receives B text within 10s', `${gotBA.ms}ms via ${gotBA.path} (conn=${gotBA.conn})`);
  timings.push(`B→A 글 도착 ${gotBA.ms}ms via ${gotBA.path}`);
  ok(B.m.unread().byPeer[A.id] >= 1 && A.m.unread().total >= 1, 'unread counters move on both sides');

  // ---- ④ 1MB 파일 ----
  t = Date.now();
  const blob = crypto.randomBytes(1024 * 1024);
  const sum = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const outFile = await A.m.sendFile(B.id, { name: 'e2e-1mb.bin', data: blob });
  ok(outFile.status === 'sent' && outFile.kind === 'file', 'A→B sendFile(1MB) → sent', outFile.error || '');
  if (outFile.file?.storagePath) objects.push(outFile.file.storagePath);
  const gotFile = await waitItem(B, A.id, (i) => i.dir === 'in' && i.kind === 'file' && i.id === outFile.id);
  ok(gotFile.item?.status === 'received', 'B receives the file envelope within 10s', `${gotFile.ms}ms via ${gotFile.path}`);
  ok(gotFile.item?.file?.size === blob.length && gotFile.item?.file?.name === 'e2e-1mb.bin', 'file envelope carries name·size');
  const saved = gotFile.item ? await B.m.fetchFile(gotFile.item.id) : null;
  const back = saved ? await fsp.readFile(saved) : Buffer.alloc(0);
  ok(back.length === blob.length && sum(back) === sum(blob), 'B fetchFile → bytes identical (sha256)', `${back.length}B`);
  timings.push(`1MB 파일 왕복 ${ms(t)} (도착 ${gotFile.ms}ms via ${gotFile.path})`);

  // ---- ⑤ V6: 끊긴 사이에 온 편지는 다시 붙을 때 메워진다 ----
  t = Date.now();
  B.m.stop();
  ok(B.m.connection === 'stopped', 'V6: B stop() → connection stopped');
  const OFF1 = 'e2e-offline-1', OFF2 = 'e2e-offline-2';
  const o1 = await A.m.sendText(B.id, OFF1);
  const o2 = await A.m.sendText(B.id, OFF2);
  ok(o1.status === 'sent' && o2.status === 'sent', 'V6: A sends 2 texts while B is offline');
  ok(!B.m.history(A.id).some(textIs(OFF1)), 'V6: B has nothing while stopped');
  await B.m.start();                                   // start() → #connect() → gapFill()
  const g1 = await waitItem(B, A.id, textIs(OFF1), { manualGapAt: Infinity });
  const g2 = await waitItem(B, A.id, textIs(OFF2), { manualGapAt: Infinity });
  ok(g1.item?.status === 'received' && g2.item?.status === 'received', 'V6: both arrive after B start() (gap-fill)', `${g1.ms}ms · ${g2.ms}ms`);
  timings.push(`V6 재연결 메우기 ${ms(t)}`);

  // ---- ⑥ V7: 같은 client_id 를 다시 INSERT 하면 409 ----
  const dup = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: outAB.id, sender: A.id, recipient: B.id, kind: 'text', body: 'ciphertext' });
  ok(dup.status === 409, 'V7: duplicate client_id INSERT → 409', `status=${dup.status}`);
  const fresh = await asUser(A.token, 'POST', '/rest/v1/messages', { client_id: crypto.randomUUID(), sender: A.id, recipient: B.id, kind: 'text', body: 'ciphertext' });
  ok(fresh.status === 201, 'V7: a new client_id still inserts (201)', `status=${fresh.status}`);

  // ---- ⑦ 차단: 서버가 막으면 편지는 3번째 시도에서 failed 로 끝난다 ----
  t = Date.now();
  ok((await B.c.respond(A.id, 'block')) === 'blocked', 'B blocks A');
  const blocked = await A.m.sendText(B.id, 'e2e-blocked');
  ok(blocked.status === 'pending' && blocked.tries === 1, 'blocked send: 1st try → pending', `tries=${blocked.tries}`);
  await A.m.flushOutbox();
  await A.m.flushOutbox();
  const endItem = A.m.history(B.id).find((i) => i.id === blocked.id);
  ok(endItem?.status === 'failed' && endItem?.tries >= 3, 'blocked send ends as failed after 3 tries', `status=${endItem?.status} tries=${endItem?.tries}`);
  ok(!B.m.history(A.id).some((i) => i.text === 'e2e-blocked'), 'blocked text never reaches B');
  ok((await B.c.respond(A.id, 'unblock')) === 'accepted', 'B unblocks A → accepted');
  timings.push(`차단·해제 ${ms(t)}`);

  console.log(`INFO realtime at end: A=${A.m.connection} B=${B.m.connection}`);
} catch (e) {
  fail += 1;
  console.log(`FAIL unexpected error — ${e?.message || e}`);
  if (e?.stack) console.log(String(e.stack).split('\n').slice(1, 5).join('\n'));
} finally {
  // 무슨 일이 있어도 흔적을 남기지 않는다: 연결 끊기 → Storage 객체 → 계정 → 임시 폴더.
  for (const p of people) { try { await p.app.shutdown(); } catch (e) { console.log(`cleanup ${p.tag} shutdown: ${e.message}`); } }
  try { await adminDeleteObjects(objects); } catch (e) { console.log(`cleanup storage: ${e.message}`); }
  for (const u of users) { try { await adminDeleteUser(u.id); } catch (e) { console.log(`cleanup ${u.tag}: ${e.message}`); } }
  for (const d of dirs) { try { await fsp.rm(d, { recursive: true, force: true }); } catch (e) { console.log(`cleanup dir: ${e.message}`); } }
}

console.log(`TIMINGS ${timings.join(' | ')}`);
console.log(`total ${ms(T0)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
