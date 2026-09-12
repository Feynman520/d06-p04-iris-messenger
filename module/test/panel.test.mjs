// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// panel.html 정적 검사: 단일 파일(바깥 링크 0) · alert/confirm/prompt 없음 · 필수 id ·
// 창구는 api() 하나(fetch 호출점 1곳) · EventSource에 토큰 · 규정된 안내 문구 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'panel.html');
const HTML = fs.readFileSync(FILE, 'utf8');

const count = (s, needle) => s.split(needle).length - 1;

test('① 한 파일 안에 다 있고 크기가 200KB보다 작다', () => {
  const bytes = Buffer.byteLength(HTML, 'utf8');
  assert.ok(bytes > 0 && bytes < 200 * 1024, `panel.html = ${bytes} bytes`);
  assert.equal(HTML.split('\n')[0].trim(), '<!-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home -->');
  assert.equal(count(HTML, '<script'), 1, '스크립트는 인라인 한 덩어리');
  assert.equal(count(HTML, '<style'), 1, '스타일도 인라인 한 덩어리');
});

test('② 바깥으로 나가는 링크가 하나도 없다(오프라인에서도 그대로 뜬다)', () => {
  for (const bad of ['src="http', "src='http", 'href="http', "href='http", 'url(http', 'url("http', "url('http", '@import', '//cdn', 'fonts.googleapis']) {
    assert.equal(HTML.includes(bad), false, `바깥 자원: ${bad}`);
  }
  assert.equal(/<link\b/i.test(HTML), false, '<link> 자체를 쓰지 않는다');
  // 남아 있는 http(s)는 머리말 저작권 줄과 사용자가 넣는 자리표시자(placeholder)뿐이다.
  const urls = HTML.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  for (const u of urls) {
    assert.ok(/feynman520\.github\.io|xxxx\.supabase\.co|127\.0\.0\.1/.test(u), `예상 밖 주소: ${u}`);
  }
});

test('③ alert·confirm·prompt를 쓰지 않는다(서랍 안에서는 막힌다)', () => {
  assert.equal(count(HTML, 'alert('), 0);
  assert.equal(count(HTML, 'confirm('), 0);
  assert.equal(count(HTML, 'prompt('), 0);
  assert.equal(count(HTML, 'window.open('), 0);
  // Escape는 Face 서랍이 쓰는 키라 화면이 가로채지 않는다.
  assert.equal(/Escape/.test(HTML.replace(/Escape는[^\n]*/g, '')), false, 'Escape를 키 처리로 쓰지 않는다');
});

test('④ 미완성 흔적이 없다', () => {
  assert.equal(count(HTML, '{{'), 0);
  assert.equal(count(HTML, 'TODO'), 0);
  assert.equal(count(HTML, 'FIXME'), 0);
});

test('⑤ 단계·본 화면의 필수 id가 모두 있다', () => {
  const ids = [
    'stage-nohub', 'stage-out', 'stage-code', 'stage-identity', 'stage-in',
    'contacts', 'chat', 'composer', 'settings-dialog', 'words-dialog',
    'invite-dialog', 'accept-dialog', 'confirm-dialog',
    'conn-dot', 'peerbar', 'file-input', 'count',
  ];
  for (const id of ids) assert.ok(HTML.includes(`id="${id}"`), `id="${id}" 가 없다`);
  assert.equal(count(HTML, '<dialog id='), 5, '대화상자는 <dialog> 5개');
});

test('⑥ 서버와 이야기하는 창구는 api() 하나뿐이다', () => {
  assert.ok(count(HTML, 'fetch(') <= 2, `fetch 호출점이 ${count(HTML, 'fetch(')}곳 — api() 하나로 모은다`);
  assert.ok(HTML.includes('async function api(p, opt)'), 'api() 도우미가 있다');
  // 모든 EventSource에는 토큰이 붙는다.
  for (const line of HTML.split('\n')) {
    if (!line.includes('new EventSource(')) continue;
    assert.ok(line.includes('?t='), `토큰 없는 EventSource: ${line.trim()}`);
  }
  assert.equal(count(HTML, 'new EventSource('), 1);
});

test('⑦ 로그인 단계의 규정 문구와 14세 확인 칸이 그대로 있다', () => {
  assert.ok(HTML.includes('만 14세 이상이며 처리방침을 읽었습니다'));
  assert.ok(HTML.includes('id="out-agree"'), '체크 전에는 코드 받기를 막는 칸');
  assert.ok(HTML.includes('<button id="out-send" class="btn primary wide" type="button" disabled>'), '코드 받기는 처음에 잠겨 있다');
  assert.ok(HTML.includes('메일에 6자리 코드가 있으면 코드를, 링크만 있으면 <strong>링크를 누르지 말고</strong> 링크 주소를 복사해 여기에 붙여 넣으세요.'));
  assert.ok(/5번[^\n]*잠깁니다/.test(HTML), '5회 잠금 안내');
});

test('⑧ 신뢰·안전 문구가 빠지지 않았다', () => {
  assert.ok(HTML.includes('상대와 직접 대조하세요. 이름은 흉내 낼 수 있지만 지문은 못 합니다.'));
  assert.ok(HTML.includes('이 코드를 상대에게 직접(카톡·말) 전하세요. 뒤 4자는 내 열쇠 지문입니다.'));
  assert.ok(HTML.includes('코드의 뒤 4자와 상대의 지문이 맞는지 확인합니다.'));
  assert.ok(HTML.includes('이 PC의 열쇠가 계정의 열쇠와 다릅니다'));
  assert.ok(HTML.includes('다시 보내려면 파일을 다시 첨부해 보내세요'));
  assert.ok(HTML.includes('파일이 너무 큽니다(10MB)'));
  assert.ok(HTML.includes('메시지·열쇠·로그인 정보가 이 PC와 서버에서 지워집니다'));
  assert.ok(HTML.includes('저장하면 로그아웃됩니다'));
  assert.ok(HTML.includes('적어 두었습니다'), '백업 문구 확인 칸');
  assert.ok(HTML.includes('hub/server/처리방침.md'));
  // 백업 문구에는 복사 단추를 두지 않는다(손으로 적게 한다).
  assert.ok(HTML.includes('복사 단추는 일부러 두지 않았습니다'));
  assert.equal(HTML.includes('navigator.clipboard'), false);
  assert.equal(HTML.includes('execCommand'), false);
});

test('⑨ 상태는 /api/state 한 덩어리에서만 온다(다른 설정 파일을 읽지 않는다)', () => {
  for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.equal(HTML.includes(bad), false, `${bad} 를 쓰지 않는다`);
  }
  for (const need of ['S.limits', 'S.riskyExt', 'S.theme', "'/api/state'"]) {
    assert.ok(HTML.includes(need), `${need} 를 state에서 읽는다`);
  }
});
