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

// 주석을 걷어낸 스크립트 알맹이 — 주석 속 낱말이 검사에 걸리지 않게 한다.
const JS = HTML.slice(HTML.indexOf('<script>'), HTML.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')   // /* … */ 통째로
  .replace(/^\s*\/\/.*$/gm, '');      // 줄 전체가 // 인 것

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

test('③ alert·confirm·prompt를 쓰지 않고 Escape를 가로채지 않는다', () => {
  assert.equal(count(HTML, 'alert('), 0);
  assert.equal(count(HTML, 'confirm('), 0);
  assert.equal(count(HTML, 'prompt('), 0);
  assert.equal(count(HTML, 'window.open('), 0);
  // Escape는 Face 서랍이 닫히는 키다 — 코드(주석 제외)에 그 이름이 아예 없어야 한다.
  assert.equal(/Escape/.test(JS), false, 'Escape를 키 처리에 쓰지 않는다');
  assert.equal(/document\.addEventListener\(\s*'key(down|up|press)'/.test(JS), false, '문서 전체에 키 처리를 걸지 않는다');
  // 키를 보는 곳은 입력칸의 Enter 하나뿐이다.
  assert.equal(count(JS, "addEventListener('keydown'"), 1);
  assert.ok(JS.includes("if (e.key !== 'Enter'"), 'Enter만 본다');
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
    'set-name', 'set-rename',
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
  // 상한 숫자는 박아 두지 않고 state().limits.fileMax 에서 만들어 쓴다.
  assert.ok(JS.includes("'파일이 너무 큽니다(' + Math.round(fileMax() / 1048576) + 'MB)'"));
  assert.equal(HTML.includes('파일이 너무 큽니다(10MB)'), false, '10MB를 글자로 박아 두지 않는다');
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

test('⑩ 새 편지가 오면 낡은 unread를 보지 않고 곧장 읽음 처리한다', () => {
  // 사건 처리기는 readOpen(true) — state의 안 읽은 수가 아직 갱신되기 전이라 첫 통을 놓치면 안 된다.
  assert.ok(JS.includes("if (d.item.dir === 'in' && document.visibilityState === 'visible') readOpen(true);"));
  assert.ok(JS.includes('async function readOpen(force)'));
  assert.ok(JS.includes('if (!force && !by[peer]) return;'));
});

test('⑪ 열쇠가 어긋난 화면에는 물어보지 않는 열쇠 파괴 단추가 없다', () => {
  // 새 열쇠 만들기는 재설정과 똑같이 이 PC의 옛 열쇠를 지운다 → keyMismatch면 감춘다.
  assert.ok(JS.includes("$('idn-normal').hidden = !!S.keyMismatch;"));
  assert.ok(JS.includes("$('idn-create').hidden = !!S.keyMismatch;"));
  assert.ok(JS.includes("if (S.keyMismatch) $('idn-words-wrap').hidden = false;"));
  // 재설정은 설정 쪽과 같은 확인 대화상자·같은 경고 문구를 쓴다(두 곳에서 ask(RESET_WARN…)).
  assert.ok(HTML.includes("재설정하면 이 PC의 옛 편지는 다시 열 수 없고 연락처들에게 '열쇠 바뀜' 경고가 갑니다"));
  assert.equal(count(JS, "ask(RESET_WARN, '열쇠 재설정')"), 2);
});

test('⑫ 서버의 영어 오류를 사람 말로 바꾼다', () => {
  const pairs = [
    ['bad email', '메일 주소 형식이 아닙니다'],
    ['bad code', '코드 또는 링크 형식이 아닙니다'],
    ['locked', '5회 틀려 잠겼습니다. 코드를 다시 받으세요'],
    ['invalid or expired invite', '초대 코드가 틀렸거나 만료됐습니다'],
    ['too many attempts, wait a minute', '시도가 너무 많습니다. 1분 뒤 다시 하세요'],
    ['fingerprint mismatch', '지문이 맞지 않습니다. 코드를 다시 확인하세요(서버가 열쇠를 바꿔치기했을 수 있습니다)'],
    ['blocked', '차단된 상대입니다'],
    ['mismatch', '12단어가 이 계정의 열쇠와 다릅니다'],
    ['display name required', '표시 이름을 넣으세요'],
    ['display name too long', '표시 이름이 너무 깁니다(40자까지)'],
    ['bad hub url or key', '서버 주소 또는 키가 올바르지 않습니다'],
    ['internal error', '내부 오류가 났습니다. 다시 시도하세요'],
    ['Token has expired or is invalid', '코드가 만료됐거나 틀렸습니다'],
  ];
  for (const [en, ko] of pairs) assert.ok(JS.includes(ko), `${en} → ${ko} 가 없다`);
  assert.ok(JS.includes("return '서버에 연결할 수 없습니다'"), '끊긴 전선');
  assert.ok(JS.includes("msg.toLowerCase().indexOf('expired') >= 0"), 'expired가 든 말은 만료로');
  assert.ok(JS.includes('  return msg;'), '모르는 말은 그대로 보여 준다');
  // 사람에게 보이는 자리는 모두 human()을 지난다(.message를 곧장 그리는 곳이 없다).
  assert.equal(/say\([^)]*\.message/.test(JS), false, 'say()에 영어 원문을 그대로 넣는 곳이 있다');
  assert.equal(/text:\s*e\.message/.test(JS), false);
  assert.equal(/fetchError = e\.message/.test(JS), false);
  assert.equal(count(JS, '.message'), 3, 'message를 읽는 곳은 human() 한 줄과 api()의 전선 오류 한 줄뿐');
  assert.ok(count(JS, 'human(e)') >= 15);
});

test('⑬ 보내는 중에는 두 번 보내지지 않고, 끝나면 입력칸으로 돌아온다', () => {
  assert.ok(JS.includes('function lockSend(on)'));
  assert.ok(JS.includes('if (sending) return;'), '보내는 중 Enter·재호출을 버린다');
  assert.ok(JS.includes("if (!$('msg').disabled) $('msg').focus();"), '끝나면 입력칸에 초점을 돌려준다');
  assert.ok(JS.includes('var ok = !why && !sending;'));
  // 서버 주소는 anon key와 짝으로만 보낸다.
  assert.ok(JS.includes("if (!key) { say('set-err', '서버를 바꾸려면 anon key도 함께 넣으세요.'); return; }"));
  assert.ok(HTML.includes('placeholder="서버를 바꿀 때만 채웁니다"'));
});
