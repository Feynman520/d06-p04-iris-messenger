// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supa, SupaError } from '../supa.mjs';
import { startMock } from './_mockhub.mjs';

function makeSupa(mock, extra = {}) {
  return new Supa({ url: mock.url, anonKey: 'anon-key', ...extra });
}

test('① otpRequest sends { email, create_user: true }', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  await supa.otpRequest('a@b.com');
  assert.equal(mock.calls.otp.length, 1);
  assert.deepEqual(mock.calls.otp[0], { email: 'a@b.com', create_user: true });
});

test('② otpVerify success sets session and fires onSession once', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  let fired = 0;
  supa.onSession(() => { fired += 1; });
  const before = Math.floor(Date.now() / 1000);
  const s = await supa.otpVerify('a@b.com', '123456');
  assert.equal(s.user.id, 'u1');
  assert.ok(Math.abs(s.expires_at - (before + 3600)) < 5);
  assert.equal(fired, 1);
});

test('③ otpVerify wrong code throws SupaError status 400 code otp_expired', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  await assert.rejects(
    () => supa.otpVerify('a@b.com', '000000'),
    (e) => e instanceof SupaError && e.status === 400 && e.code === 'otp_expired',
  );
});

test('④ ensureFresh refreshes when close to expiry', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at-old', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 60, user: { id: 'u1' } });
  await supa.ensureFresh();
  assert.equal(supa.session.access_token, 'at2');
});

test('⑤ select 401 auto-refreshes then retries successfully', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at-old', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  const rows = await supa.select('things');
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(supa.session.access_token, 'at2');
});

test('⑥ insert 409 throws SupaError code 23505', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  await assert.rejects(
    () => supa.insert('things', { client_id: 'dup' }),
    (e) => e instanceof SupaError && e.code === '23505',
  );
});

test('⑦ rpc echo returns args', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  const r = await supa.rpc('echo', { a: 1 });
  assert.deepEqual(r, { a: 1 });
});

test('⑧ upload then download returns identical bytes', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  const data = Buffer.from('hello world');
  await supa.upload('files', 'a/b.bin', data);
  const back = await supa.download('files', 'a/b.bin');
  assert.ok(Buffer.isBuffer(back));
  assert.deepEqual(back, data);
});

test('⑨ download 404 throws SupaError status 404', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  await assert.rejects(
    () => supa.download('files', 'missing.bin'),
    (e) => e instanceof SupaError && e.status === 404,
  );
});

test('⑩ logout clears session', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  supa.setSession({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 9999, user: { id: 'u1' } });
  await supa.logout();
  assert.equal(supa.session, null);
});

test('⑪ otpVerify pasted magic link (token= query) succeeds via type magiclink', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  const s = await supa.otpVerify('a@b.com', 'https://x.supabase.co/auth/v1/verify?token=hash-ok&type=magiclink&redirect_to=x');
  assert.equal(s.user.id, 'u1');
  assert.equal(mock.calls.verify.at(-1).token_hash, 'hash-ok');
  assert.equal(mock.calls.verify.at(-1).type, 'magiclink');
  assert.equal('email' in mock.calls.verify.at(-1), false);
});

test('⑫ otpVerify pasted link without token/token_hash → SupaError bad_input', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  await assert.rejects(
    () => supa.otpVerify('a@b.com', 'https://x/none'),
    (e) => e instanceof SupaError && e.status === 400 && e.code === 'bad_input',
  );
});

test('subscribe throws SupaError when WebSocketImpl is null', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = new Supa({ url: mock.url, anonKey: 'anon-key', WebSocketImpl: null });
  assert.throws(
    () => supa.subscribe({ table: 'inbox', onChange: () => {} }),
    (e) => e instanceof SupaError && e.message === 'WebSocket unavailable',
  );
});

test('onSession returns an unsubscribe function', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const supa = makeSupa(mock);
  let calls = 0;
  const off = supa.onSession(() => { calls += 1; });
  supa.setSession({ access_token: 'x', refresh_token: 'y', expires_at: 0, user: {} });
  assert.equal(calls, 1);
  off();
  supa.setSession(null);
  assert.equal(calls, 1);
});
