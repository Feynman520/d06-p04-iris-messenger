// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FP_ALPHABET,
  generateEntropy,
  entropyToMnemonic,
  mnemonicToEntropy,
  deriveKeyPair,
  fingerprint,
  b64,
  x25519PrivateKey,
  x25519PublicKey,
} from '../keys.mjs';

test('① entropyToMnemonic(zero 16 bytes) = BIP39 standard vector (abandon×11 + about)', () => {
  const words = entropyToMnemonic(Buffer.alloc(16));
  assert.deepEqual(words, ['abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'about']);
});

test('② mnemonicToEntropy(standard vector) = 16 zero bytes', () => {
  const ent = mnemonicToEntropy('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  assert.ok(Buffer.alloc(16).equals(ent));
  // array form also accepted
  const ent2 = mnemonicToEntropy(['abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'about']);
  assert.ok(Buffer.alloc(16).equals(ent2));
});

test('③ random entropy round-trip 100 times', () => {
  for (let i = 0; i < 100; i++) {
    const entropy = generateEntropy();
    assert.equal(entropy.length, 16);
    const words = entropyToMnemonic(entropy);
    assert.equal(words.length, 12);
    const back = mnemonicToEntropy(words);
    assert.ok(entropy.equals(back), `round-trip mismatch on iteration ${i}`);
  }
});

test('④ tampering last word breaks checksum', () => {
  const words = entropyToMnemonic(Buffer.alloc(16));
  const tampered = words.slice(0, 11).concat('abandon');
  // 'abandon abandon...abandon abandon' (12x abandon) has a different checksum than 11x abandon + about
  assert.throws(() => mnemonicToEntropy(tampered), /bad mnemonic/);
});

test('⑤ unknown word throws', () => {
  const words = entropyToMnemonic(Buffer.alloc(16));
  const bad = words.slice(0, 11).concat('notarealbip39word');
  assert.throws(() => mnemonicToEntropy(bad), /bad mnemonic/);
});

test('⑥ deriveKeyPair is deterministic per entropy, differs across entropy', () => {
  const entropyA = Buffer.alloc(16, 1);
  const entropyB = Buffer.alloc(16, 2);
  const a1 = deriveKeyPair(entropyA);
  const a2 = deriveKeyPair(entropyA);
  const b = deriveKeyPair(entropyB);
  assert.ok(a1.publicRaw.equals(a2.publicRaw));
  assert.ok(a1.privateRaw.equals(a2.privateRaw));
  assert.equal(a1.publicRaw.length, 32);
  assert.equal(a1.privateRaw.length, 32);
  assert.ok(!a1.publicRaw.equals(b.publicRaw));
});

test('⑦ fingerprint is length 8, within FP_ALPHABET', () => {
  const { publicRaw } = deriveKeyPair(generateEntropy());
  const fp = fingerprint(publicRaw);
  assert.equal(fp.length, 8);
  for (const ch of fp) assert.ok(FP_ALPHABET.includes(ch), `char ${ch} not in alphabet`);
});

test('⑧ x25519PublicKey(publicRaw) SPKI DER last 32 bytes === publicRaw', () => {
  const { publicRaw } = deriveKeyPair(generateEntropy());
  const der = x25519PublicKey(publicRaw).export({ type: 'spki', format: 'der' });
  assert.ok(Buffer.from(der.subarray(der.length - 32)).equals(publicRaw));
});

test('b64 enc/dec round-trip', () => {
  const buf = crypto.randomBytes(32);
  assert.ok(b64.dec(b64.enc(buf)).equals(buf));
});

test('x25519PrivateKey produces a usable key object (diffieHellman round trip)', () => {
  const a = deriveKeyPair(generateEntropy());
  const b = deriveKeyPair(generateEntropy());
  const s1 = crypto.diffieHellman({ privateKey: x25519PrivateKey(a.privateRaw), publicKey: x25519PublicKey(b.publicRaw) });
  const s2 = crypto.diffieHellman({ privateKey: x25519PrivateKey(b.privateRaw), publicKey: x25519PublicKey(a.publicRaw) });
  assert.ok(s1.equals(s2));
});
