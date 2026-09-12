// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Supa } from '../supa.mjs';
import { Contacts, parseInvite, INVITE_RE } from '../contacts.mjs';
import { b64, generateEntropy, deriveKeyPair, fingerprint } from '../keys.mjs';
import { startMock } from './_mockhub.mjs';

test('parseInvite: normalizes and validates IRIS-xxxx-xxxx-xxxx codes', () => {
  // ① 공백·소문자 정규화
  assert.deepEqual(parseInvite(' iris-ab2c-de3f-gh4j '), { code8: 'AB2CDE3F', fp4: 'GH4J' });
  // 그룹 수가 모자라면 null
  assert.equal(parseInvite('IRIS-AB2C-DE3F'), null);
  // 전각/변형 대시도 정규화
  assert.deepEqual(parseInvite('IRIS–AB2C–DE3F–GH4J'), { code8: 'AB2CDE3F', fp4: 'GH4J' });
});

function setupContacts(mock, stateDir) {
  const supa = new Supa({ url: mock.url, anonKey: 'anon-key' });
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1', email: 'a@b.com' } });
  const identity = { fingerprint: 'ABCDEFGH' }; // 8자 표시용 대역(FP_ALPHABET 문자만) — createInvite 꼬리 확인용
  const contacts = new Contacts({ stateDir, supa, identity, me: () => 'u1' });
  return { supa, identity, contacts };
}

test('Contacts: invite codes, mutual accept, key pinning', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-contacts-'));
  const { identity, contacts } = setupContacts(mock, stateDir);
  await contacts.load();

  // ② createInvite() 형식 일치, 뒤 4자 = 내 지문 앞 4자
  const invite = await contacts.createInvite();
  assert.match(invite, INVITE_RE);
  assert.equal(invite.slice(-4), identity.fingerprint.slice(0, 4));

  // 상대(u2) 쪽 초대 준비: 임의 키쌍 + 그 공개키 지문
  const otherKeys = deriveKeyPair(generateEntropy());
  const otherFp = fingerprint(otherKeys.publicRaw);
  const otherPub = b64.enc(otherKeys.publicRaw);
  mock.store.invites.set('BBBBBBBB', { owner_id: 'u2', display_name: '보라', public_key: otherPub, key_version: 1 });
  const goodInvite = `IRIS-BBBB-BBBB-${otherFp.slice(0, 4)}`;
  const badInvite = 'IRIS-BBBB-BBBB-ZZZZ';

  // ③ 지문 불일치 → throw, 서버 호출 순서 lookup_invite만(accept 호출 안 됨)
  mock.calls.invite.length = 0;
  await assert.rejects(() => contacts.acceptInvite(badInvite), /fingerprint mismatch/);
  assert.deepEqual(mock.calls.invite.map((c) => c.fn), ['lookup_invite']);
  assert.equal(contacts.get('u2'), null);

  // ④ 지문 일치 → accept_invite 호출, pin 저장, list()에 pending_out
  mock.calls.invite.length = 0;
  const accepted = await contacts.acceptInvite(goodInvite);
  assert.equal(accepted.id, 'u2');
  assert.equal(accepted.displayName, '보라');
  assert.deepEqual(mock.calls.invite.map((c) => c.fn), ['lookup_invite', 'accept_invite']);
  let entry = contacts.get('u2');
  assert.equal(entry.status, 'pending_out');
  assert.equal(entry.requestedByMe, true);
  assert.equal(entry.publicKey, otherPub);
  assert.deepEqual(Buffer.from(contacts.publicKeyOf('u2')), Buffer.from(otherKeys.publicRaw));
  const onDisk1 = JSON.parse(fssync.readFileSync(path.join(stateDir, 'contacts.json'), 'utf8'));
  assert.equal(onDisk1.pins.u2.publicKey, otherPub);

  // ⑤ mock에서 상대가 수락한 상태로 바꾼 뒤 sync() → accepted
  mock.store.contacts[0].status = 'accepted';
  mock.store.profiles.push({ id: 'u2', display_name: '보라', public_key: otherPub, key_version: 1 });
  await contacts.sync();
  entry = contacts.get('u2');
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.keyChanged, false);

  // ⑥ 서버 public_key 바꾼 뒤 sync() → keyChanged true, publicKeyOf는 옛 값
  const newerKeys = deriveKeyPair(generateEntropy());
  const newerPub = b64.enc(newerKeys.publicRaw);
  mock.store.profiles[0].public_key = newerPub;
  mock.store.profiles[0].key_version = 2;
  await contacts.sync();
  entry = contacts.get('u2');
  assert.equal(entry.keyChanged, true);
  assert.deepEqual(Buffer.from(contacts.publicKeyOf('u2')), Buffer.from(otherKeys.publicRaw));

  // ⑦ acceptKeyChange → keyChanged false, 새 값
  contacts.acceptKeyChange('u2');
  entry = contacts.get('u2');
  assert.equal(entry.keyChanged, false);
  assert.deepEqual(Buffer.from(contacts.publicKeyOf('u2')), Buffer.from(newerKeys.publicRaw));

  // ⑧ respond(id,'block') → blocked_by_me
  await contacts.respond('u2', 'block');
  entry = contacts.get('u2');
  assert.equal(entry.status, 'blocked_by_me');

  // ⑨ respond(id,'remove') → 목록에서 사라지고 pin 삭제
  await contacts.respond('u2', 'remove');
  assert.equal(contacts.get('u2'), null);
  assert.equal(contacts.list().some((c) => c.id === 'u2'), false);
  const onDisk2 = JSON.parse(fssync.readFileSync(path.join(stateDir, 'contacts.json'), 'utf8'));
  assert.equal(onDisk2.pins.u2, undefined);
});

test('Contacts.sync: 지문을 맞춰 본 적 없이 고정된 열쇠는 needsVerify 로 표시된다(TOFU)', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-contacts-'));
  const { contacts } = setupContacts(mock, stateDir);
  await contacts.load();

  // 상대가 먼저 초대하고 내가 (다른 기기에서) 수락해 둔 관계 — 이 기기에는 pin 이 없다.
  const otherKeys = deriveKeyPair(generateEntropy());
  const otherPub = b64.enc(otherKeys.publicRaw);
  mock.store.contacts.push({ user_a: 'u1', user_b: 'u2', status: 'accepted', requested_by: 'u2', blocked_by: null });
  mock.store.profiles.push({ id: 'u2', display_name: '보라', public_key: otherPub, key_version: 1 });

  await contacts.sync();
  let entry = contacts.get('u2');
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.keyChanged, false);
  assert.equal(entry.needsVerify, true, '서버에서 받아 그대로 고정한 열쇠');
  assert.deepEqual(Buffer.from(contacts.publicKeyOf('u2')), Buffer.from(otherKeys.publicRaw), '편지를 열 수는 있어야 한다');
  const onDisk = JSON.parse(fssync.readFileSync(path.join(stateDir, 'contacts.json'), 'utf8'));
  assert.equal(onDisk.pins.u2.pinnedBy, 'sync');
  assert.equal(onDisk.pins.u2.needsVerify, true);

  // 다시 sync() 해도 표식은 그대로 남는다(사람이 확인하기 전까지).
  await contacts.sync();
  assert.equal(contacts.get('u2').needsVerify, true);

  // 사용자가 지문을 직접 대조하고 "새 지문 확인"을 누르면 표식이 사라진다.
  await contacts.acceptKeyChange('u2');
  entry = contacts.get('u2');
  assert.equal(entry.needsVerify, false);
  assert.deepEqual(Buffer.from(contacts.publicKeyOf('u2')), Buffer.from(otherKeys.publicRaw), '열쇠 자체는 그대로');
  const after = JSON.parse(fssync.readFileSync(path.join(stateDir, 'contacts.json'), 'utf8'));
  assert.equal(after.pins.u2.needsVerify, undefined);
  assert.equal(after.pins.u2.pinnedBy, undefined);

  // 초대 코드로 지문을 맞춰 고정한 열쇠에는 애초에 표식이 붙지 않는다.
  await contacts.sync();
  assert.equal(contacts.get('u2').needsVerify, false);
});

test('Contacts.acceptInvite: server accept_invite invalid/rate_limited/blocked → throws, no pin', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-contacts-'));
  const { contacts } = setupContacts(mock, stateDir);
  await contacts.load();

  const otherKeys = deriveKeyPair(generateEntropy());
  const otherFp = fingerprint(otherKeys.publicRaw);
  mock.store.invites.set('CCCCCCCC', { owner_id: 'u3', display_name: '민준', public_key: b64.enc(otherKeys.publicRaw), key_version: 1 });
  const invite = `IRIS-CCCC-CCCC-${otherFp.slice(0, 4)}`;

  mock.store.acceptStatus = 'invalid';
  await assert.rejects(() => contacts.acceptInvite(invite), /invalid or expired invite/);
  assert.equal(contacts.get('u3'), null);

  mock.store.acceptStatus = 'rate_limited';
  await assert.rejects(() => contacts.acceptInvite(invite), /too many attempts, wait a minute/);
  assert.equal(contacts.get('u3'), null);

  mock.store.acceptStatus = 'blocked';
  await assert.rejects(() => contacts.acceptInvite(invite), /: blocked$/);
  assert.equal(contacts.get('u3'), null);

  assert.equal(mock.store.contacts.length, 0); // 셋 다 pending 계약 미충족 → contacts 행을 만들지 않음
});
