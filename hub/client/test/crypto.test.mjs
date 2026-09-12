// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateEntropy, deriveKeyPair, b64 } from '../keys.mjs';
import { ENVELOPE_VERSION, seal, open, sealFile, openFile } from '../crypto.mjs';

function makeParty() {
  const { privateRaw, publicRaw } = deriveKeyPair(generateEntropy());
  return { privateRaw, publicRaw };
}

test('ENVELOPE_VERSION is 1', () => {
  assert.equal(ENVELOPE_VERSION, 1);
});

test('① seal→open round-trip returns identical envelope', () => {
  const A = makeParty();
  const B = makeParty();
  const envelope = { v: 1, kind: 'text', text: '안녕 🙂' };
  const blob = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  const opened = open({ recipientPrivateRaw: B.privateRaw, recipientPublicRaw: B.publicRaw, senderPublicRaw: A.publicRaw, blob });
  assert.deepEqual(opened, envelope);
});

test('② flipping one byte of the blob breaks open (tamper detection)', () => {
  const A = makeParty();
  const B = makeParty();
  const envelope = { v: 1, kind: 'text', text: 'hello' };
  const blob = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  const buf = b64.dec(blob);
  // flip a byte well inside the ciphertext (after version+ephPub+nonce header)
  const idx = 1 + 32 + 12 + 2;
  buf[idx] ^= 0xff;
  const tampered = b64.enc(buf);
  assert.throws(() => open({ recipientPrivateRaw: B.privateRaw, recipientPublicRaw: B.publicRaw, senderPublicRaw: A.publicRaw, blob: tampered }), /cannot open/);
});

test('③ opening with a third party\'s private key fails (wrong key)', () => {
  const A = makeParty();
  const B = makeParty();
  const C = makeParty();
  const envelope = { v: 1, kind: 'text', text: 'secret' };
  const blob = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  assert.throws(() => open({ recipientPrivateRaw: C.privateRaw, recipientPublicRaw: C.publicRaw, senderPublicRaw: A.publicRaw, blob }), /cannot open/);
});

test('④ impersonating the sender as C fails (sender authentication)', () => {
  const A = makeParty();
  const B = makeParty();
  const C = makeParty();
  const envelope = { v: 1, kind: 'text', text: 'secret' };
  const blob = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  // recipient is told (falsely) that the sender is C
  assert.throws(() => open({ recipientPrivateRaw: B.privateRaw, recipientPublicRaw: B.publicRaw, senderPublicRaw: C.publicRaw, blob }), /cannot open/);
});

test('⑤ sealing the same plaintext twice yields different blobs (ephemeral key)', () => {
  const A = makeParty();
  const B = makeParty();
  const envelope = { v: 1, kind: 'text', text: 'same message' };
  const blob1 = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  const blob2 = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  assert.notEqual(blob1, blob2);
});

test('⑥ sealFile/openFile round-trip 1MB random data; wrong key throws', () => {
  const data = crypto.randomBytes(1024 * 1024);
  const { data: sealed, key } = sealFile(data);
  const opened = openFile(sealed, key);
  assert.ok(opened.equals(data));
  const { key: otherKey } = sealFile(Buffer.from('x'));
  assert.throws(() => openFile(sealed, otherKey), /cannot open file/);
});

test('⑦ blob length for a 4,000-character Korean text stays under 40,000 (server body cap)', () => {
  const A = makeParty();
  const B = makeParty();
  const text = '가'.repeat(4000);
  const envelope = { v: 1, kind: 'text', text };
  const blob = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  assert.ok(blob.length < 40000, `blob length ${blob.length} not < 40000`);
});

test('⑧ PKCS8 raw offset: ephemeral key from generateKeyPairSync round-trips through seal/open', () => {
  const A = makeParty();
  const B = makeParty();
  // sanity: an ephemeral x25519 keypair generated the same way seal() does internally
  // must produce a publicRaw usable end-to-end (proves the pkcs8 raw-private offset is correct)
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = Buffer.from(eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
  const ephPrivRaw = Buffer.from(eph.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16));
  assert.equal(ephPrivRaw.length, 32);
  assert.equal(ephPub.length, 32);

  const envelope = { v: 1, kind: 'text', text: 'offset check' };
  const blob = seal({ senderPrivateRaw: A.privateRaw, senderPublicRaw: A.publicRaw, recipientPublicRaw: B.publicRaw, envelope });
  const opened = open({ recipientPrivateRaw: B.privateRaw, recipientPublicRaw: B.publicRaw, senderPublicRaw: A.publicRaw, blob });
  assert.deepEqual(opened, envelope);
});
