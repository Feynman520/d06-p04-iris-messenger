// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 계약 v1 전선 시험: 실제 자식 프로세스를 띄워 hello→panel·badge, 토큰 문지기, 모르는 말 무시, shutdown 2초 안 종료.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// stdout을 줄 단위로 모으고, 기다리는 쪽에 하나씩 건넨다.
function lineStream(stream) {
  const queue = [];
  const waiters = [];
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { if (waiters.length) waiters.shift()(line); else queue.push(line); }
      i = buf.indexOf('\n');
    }
  });
  return {
    pending: () => queue.length,
    next(ms = 8000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('시간 안에 stdout 줄이 오지 않았다')), ms);
        waiters.push((l) => { clearTimeout(timer); resolve(l); });
      });
    },
  };
}

// 모듈 프로세스 하나를 띄우고, 시험이 끝나면 그 PID만 정리한다.
function startModule(t) {
  const stateDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'iris-stdio-'));
  const child = spawn(process.execPath, ['index.mjs'], {
    cwd: MODULE_DIR,
    env: { ...process.env, IRIS_MODULE_NAME: 'messenger', IRIS_MODULE_STATE: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = lineStream(child.stdout);
  const errChunks = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => errChunks.push(d));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(); // 내가 띄운 이 PID 하나만
      await delay(100);
    }
    fssync.rmSync(stateDir, { recursive: true, force: true });
  });
  const say = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const exited = (ms) => Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    delay(ms).then(() => ({ code: 'timeout', signal: null })),
  ]);
  return { child, out, stateDir, say, exited, stderr: () => errChunks.join('') };
}

const hello = (stateDir) => ({ t: 'hello', contract: 1, face: '2.49.0', stateDir, lang: 'ko', theme: { id: 'indigo', mode: 'dark' } });

test('hello → panel·badge, 토큰 문지기, 모르는 말 무시, shutdown 2초 안 exit 0', async (t) => {
  const m = startModule(t);
  m.say(hello(m.stateDir));

  const panel = JSON.parse(await m.out.next());
  assert.equal(panel.t, 'panel');
  assert.match(panel.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{16}$/);
  assert.ok(panel.url.length <= 300);

  const badge = JSON.parse(await m.out.next());
  assert.deepEqual(badge, { t: 'badge', count: 0 });

  // 화면은 토큰이 있을 때만 열린다.
  const ok = await fetch(panel.url);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /IRIS Messenger/);
  assert.equal((await fetch(panel.url.split('?')[0])).status, 403);

  // 네트워크 없이도 로그인 전 상태를 내놓는다(App.init은 허브를 만지지 않는다).
  const token = new URL(panel.url).searchParams.get('t');
  const origin = new URL(panel.url).origin;
  const state = await (await fetch(`${origin}/api/state?t=${token}`)).json();
  assert.equal(state.stage, 'out');
  assert.deepEqual(state.theme, { id: 'indigo', mode: 'dark' });
  assert.equal(state.hub.custom, false);

  // 계약에 없는 말은 조용히 버린다(stderr 로그만, 프로세스는 살아 있다).
  m.say({ t: 'nonsense', payload: 'x' });
  m.child.stdin.write('이건 JSON이 아니다\n');
  await delay(400);
  assert.equal(m.out.pending(), 0, '모르는 말에는 아무 것도 내보내지 않는다');
  assert.equal(m.child.exitCode, null, '모르는 말에 죽지 않는다');
  assert.match(m.stderr(), /dropped/);

  // shutdown → 2초 안에 exit 0
  const started = Date.now();
  m.say({ t: 'shutdown' });
  const { code } = await m.exited(2000);
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 2000, '2초 안에 끝난다');
});

test('stdin이 닫히면 스스로 끝난다(exit 0)', async (t) => {
  const m = startModule(t);
  m.say(hello(m.stateDir));
  await m.out.next(); // panel
  await m.out.next(); // badge

  m.child.stdin.end();
  const { code } = await m.exited(2000);
  assert.equal(code, 0);
});

test('state 폴더는 hello.stateDir 를 쓴다(설정 파일이 그 안에 생긴다)', async (t) => {
  const m = startModule(t);
  m.say(hello(m.stateDir));
  const panel = JSON.parse(await m.out.next());
  await m.out.next();

  const origin = new URL(panel.url).origin;
  const token = new URL(panel.url).searchParams.get('t');
  const r = await fetch(`${origin}/api/settings?t=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifyMuted: true }),
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(fssync.readFileSync(path.join(m.stateDir, 'settings.json'), 'utf8')).notifyMuted, true);

  m.say({ t: 'shutdown' });
  assert.equal((await m.exited(2000)).code, 0);
});
