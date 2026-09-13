// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 화면 정적 검사: 세 조각(panel.html·css·js)이 한 장으로 조립되고(바깥 링크 0) · alert/confirm/prompt 없음 ·
// 필수 id · 창구는 api() 하나(fetch 호출점 1곳) · EventSource에 토큰 · 규정된 안내 문구 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPanel, assemble } from '../panel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..');
const HTML = loadPanel(DIR);
const RAW_JS = fs.readFileSync(path.join(DIR, 'panel.js'), 'utf8');
const RAW_CSS = fs.readFileSync(path.join(DIR, 'panel.css'), 'utf8');

const count = (s, needle) => s.split(needle).length - 1;

// 주석을 걷어낸 스크립트 알맹이 — 주석 속 낱말이 검사에 걸리지 않게 한다.
const JS = RAW_JS
  .replace(/\/\*[\s\S]*?\*\//g, '')   // /* … */ 통째로
  .replace(/^\s*\/\/.*$/gm, '');      // 줄 전체가 // 인 것

test('⓪ 조립기: 세 조각이 한 장이 되고, 자리가 없거나 닫는 꼬리표가 섞이면 거부한다', () => {
  assert.ok(HTML.includes(RAW_CSS.trimEnd()), 'css 가 그대로 들어간다');
  assert.ok(HTML.includes(RAW_JS.trimEnd()), 'js 가 그대로 들어간다');
  assert.equal(HTML.includes('<!--@css-->'), false);
  assert.equal(HTML.includes('<!--@js-->'), false);
  assert.throws(() => assemble('<html></html>', '', ''), /slots/);
  assert.throws(() => assemble('<style><!--@css--></style><script><!--@js--></script>', '', 'x</script>'), /script/);
  assert.throws(() => assemble('<style><!--@css--></style><script><!--@js--></script>', 'a</style>', ''), /style/);
  // 조립 결과는 $ 치환 규칙에 휘둘리지 않는다($& 같은 글자가 그대로 남는다).
  assert.ok(assemble('<style><!--@css--></style><script><!--@js--></script>', 'a{content:"$&"}', 'var s="$1";').includes('$&'));
});

test('① 한 장 안에 다 있고 크기가 200KB보다 작다', () => {
  const bytes = Buffer.byteLength(HTML, 'utf8');
  assert.ok(bytes > 0 && bytes < 200 * 1024, `panel = ${bytes} bytes`);
  assert.equal(HTML.split('\n')[0].trim(), '<!-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home -->');
  assert.equal(count(HTML, '<script'), 1, '스크립트는 인라인 한 덩어리');
  assert.equal(count(HTML, '<style'), 1, '스타일도 인라인 한 덩어리');
});

test('② 바깥에서 불러오는 자원이 하나도 없다(오프라인에서도 그대로 뜬다)', () => {
  for (const bad of ['src="http', "src='http", 'url(http', 'url("http', "url('http", '@import', '//cdn', 'fonts.googleapis']) {
    assert.equal(HTML.includes(bad), false, `바깥 자원: ${bad}`);
  }
  assert.equal(/<link\b/i.test(HTML), false, '<link> 자체를 쓰지 않는다');
  // 남아 있는 http(s)는 머리말 저작권 줄, 자리표시자(placeholder), 그리고 사람이 눌러서 여는
  // 처리방침 링크뿐이다(불러오는 자원이 아니라 이동하는 주소 — 오프라인에서도 화면은 그대로 뜬다).
  const urls = HTML.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  for (const u of urls) {
    // www.w3.org/2000/svg 는 SVG 이름공간 문자열(createElementNS)이지 불러오는 주소가 아니다.
    assert.ok(/feynman520\.github\.io|xxxx\.supabase\.co|127\.0\.0\.1|github\.com\/Feynman520\/d06-p04-iris-messenger|^https?:\/\/…$|^http:\/\/www\.w3\.org\/2000\/svg$/.test(u), `예상 밖 주소: ${u}`);
  }
  // 바깥으로 나가는 링크는 새 탭 + rel="noopener" 로만 연다.
  for (const m of HTML.match(/<a [^>]*href="https?:[^>]*>/g) || []) {
    assert.ok(m.includes('target="_blank"') && m.includes('rel="noopener"'), `안전하지 않은 링크: ${m}`);
  }
  // 그림 글자는 안에 담아 둔 <symbol> 을 <use href="#…"> 로만 꺼낸다.
  for (const m of HTML.match(/<use [^>]*>/g) || []) assert.ok(/href="#i-[a-z]+"/.test(m), `바깥 그림: ${m}`);
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
    'contacts', 'chat', 'composer', 'settings-page', 'set-back', 'words-dialog',
    'invite-dialog', 'accept-dialog', 'confirm-dialog',
    'conn-dot', 'peerbar', 'file-input', 'count',
    'set-name', 'set-rename', 'idn-missing', 'idn-register',
    'btn-plus', 'menu-plus', 'btn-invite', 'btn-accept', 'btn-settings',
    'code-input', 'code-link', 'code-more', 'link-privacy',
    'me-avatar', 'set-avatar', 'set-avatar-img', 'set-avatar-ini', 'menu-avatar', 'set-avatar-pick', 'set-avatar-remove', 'avatar-input',
    'set-words', 'set-mute', 'set-logout', 'set-reset', 'set-delete', 'set-version',
  ];
  for (const id of ids) assert.ok(HTML.includes(`id="${id}"`), `id="${id}" 가 없다`);
  assert.equal(count(HTML, '<dialog id='), 4, '대화상자는 <dialog> 4개(설정은 한 장 화면)');
  assert.equal(HTML.includes('settings-dialog'), false, '설정 팝업은 더 이상 없다');
  // 제목은 영어 IRIS Messenger — 문 화면 4장. 본 화면 왼쪽 줄에는 두지 않는다(v0.3.2: Face 서랍 머리와 겹침).
  assert.equal(count(HTML, '<span class="word">IRIS</span><span class="sub">Messenger</span>'), 4);
  for (const id of ['set-url', 'set-key', 'set-hub', 'out-hub', 'me-fp']) assert.equal(HTML.includes(`id="${id}"`), false, `${id}: 서버 주소·내 고유번호는 화면에 없다(v0.3.2)`);
  assert.ok(HTML.includes('친구목록') && HTML.includes('친구 추가') && !HTML.includes('연락처'), '연락처 → 친구목록');
  assert.equal(HTML.includes('지문'), false, '지문 → 고유번호');
  assert.equal(HTML.includes('백업 문구'), false, '백업 문구 → 복구 단어');
  assert.equal(HTML.includes('왼쪽에서 대화할 사람을 고르세요'), false);
  assert.ok(HTML.includes('<title>IRIS Messenger</title>'));
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
  assert.ok(HTML.includes('id="out-agree"'), '체크 전에는 인증번호 받기를 막는 칸');
  assert.ok(HTML.includes('<button id="out-send" class="btn primary wide" type="button" disabled>'), '인증번호 받기는 처음에 잠겨 있다');
  assert.ok(HTML.includes('메일 주소를 적으면 인증번호 6자리를 보내 드립니다. 이 PC에서는 한 번만 하면 됩니다.'));
  assert.ok(HTML.includes('그 단추(링크)를 <strong>누르지 말고</strong>'), '링크 붙여넣기 안내');
  assert.ok(/5번[^\n]*잠깁니다/.test(HTML), '5회 잠금 안내');
  // 인증번호 칸은 숫자 6자리만 받고, 다 차면 스스로 확인한다. 링크는 접힌 칸에 따로.
  assert.ok(HTML.includes('inputmode="numeric"') && HTML.includes('maxlength="6"'));
  assert.ok(JS.includes("if (v.length === 6 && !$('code-link').value.trim()) verifyCode();"));
  assert.ok(JS.includes("var code = link || $('code-input').value.trim();"));
});

test('⑧ 신뢰·안전 문구가 빠지지 않았다', () => {
  assert.ok(HTML.includes('상대와 직접 대조하세요. 이름은 흉내 낼 수 있지만 고유번호는 못 합니다.'));
  assert.ok(HTML.includes('이 코드를 상대에게 직접(카톡·말) 전하세요. 뒤 4자는 내 고유번호의 일부입니다.'));
  assert.ok(HTML.includes('코드의 뒤 4자와 상대의 고유번호가 맞는지 확인합니다.'));
  assert.ok(HTML.includes('이 PC의 열쇠가 계정의 열쇠와 다릅니다'));
  assert.ok(HTML.includes('서버에 프로필이 없습니다. 이 PC의 열쇠를 등록하거나 복구 단어로 복원하세요'));
  assert.ok(HTML.includes('이 열쇠는 서버에서 받아 그대로 고정한 것입니다. 고유번호를 상대에게 직접 확인한 뒤 아래 단추를 누르세요.'));
  assert.ok(HTML.includes('고유번호 재확인 필요'), '아직 대조하지 않은 열쇠의 표식');
  assert.ok(HTML.includes('다시 보내려면 파일을 다시 첨부해 보내세요'));
  // 상한 숫자는 박아 두지 않고 state().limits.fileMax 에서 만들어 쓴다.
  assert.ok(JS.includes("'파일이 너무 큽니다(' + Math.round(fileMax() / 1048576) + 'MB)'"));
  assert.equal(HTML.includes('파일이 너무 큽니다(10MB)'), false, '10MB를 글자로 박아 두지 않는다');
  assert.ok(HTML.includes('메시지·열쇠·로그인 정보가 이 PC와 서버에서 지워집니다'));
  assert.equal(HTML.includes('저장하면 로그아웃됩니다'), false, '서버 주소 칸은 화면에서 뺐다(v0.3.2)');
  assert.ok(HTML.includes('적어 두었습니다'), '복구 단어 확인 칸');
  // 처리방침은 링크만 — 모듈이 같은 문지기로 내주는 /privacy 한 장을 새 창으로 연다(토큰은 시작 때 붙인다).
  assert.ok(HTML.includes('<a id="link-privacy" href="/privacy" target="_blank" rel="noopener">처리방침 읽기</a>'));
  assert.ok(JS.includes("$('link-privacy').href = '/privacy?t=' + encodeURIComponent(T);"));
  assert.equal(HTML.includes('서버에는 암호문만 지납니다'), false, '삭제하기로 한 문장(2026-09-13)');
  // 프로필 사진: PC 안에서 96×96 JPEG 로 줄여 보내고, 서버 상한(32KB)보다 작은 24KB 를 지킨다.
  assert.ok(JS.includes('var AVATAR_PX = 96;') && JS.includes('var AVATAR_BYTES = 24 * 1024;'));
  assert.ok(JS.includes("c.toDataURL('image/jpeg', q)"));
  // 복구 단어에는 복사 단추를 두지 않는다(손으로 적게 한다).
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
  // 시작(새 열쇠 만들기)은 재설정과 똑같이 이 PC의 옛 열쇠를 지운다 → keyMismatch면 감춘다.
  assert.ok(JS.includes("$('idn-normal').hidden = !!S.keyMismatch;"));
  assert.ok(JS.includes("$('idn-create').hidden = !!S.keyMismatch;"));
  assert.ok(JS.includes("if (S.keyMismatch) $('idn-words-wrap').hidden = false;"));
  // 재설정은 설정 쪽과 같은 확인 대화상자·같은 경고 문구를 쓴다(두 곳에서 ask(RESET_WARN…)).
  assert.ok(HTML.includes("재설정하면 이 PC의 옛 편지는 다시 열 수 없고 친구들에게 '열쇠 바뀜' 경고가 갑니다"));
  assert.equal(count(JS, "ask(RESET_WARN, '열쇠 재설정')"), 2);
});

test('⑫ 서버의 영어 오류를 사람 말로 바꾼다', () => {
  const pairs = [
    ['bad email', '메일 주소 형식이 아닙니다'],
    ['bad code', '인증번호 또는 링크 형식이 아닙니다'],
    ['locked', '5회 틀려 잠겼습니다. 인증번호를 다시 받으세요'],
    ['invalid or expired invite', '초대 코드가 틀렸거나 만료됐습니다'],
    ['too many attempts, wait a minute', '시도가 너무 많습니다. 1분 뒤 다시 하세요'],
    ['fingerprint mismatch', '고유번호가 맞지 않습니다. 코드를 다시 확인하세요(서버가 열쇠를 바꿔치기했을 수 있습니다)'],
    ['blocked', '차단된 상대입니다'],
    ['mismatch', '복구 단어가 이 계정의 열쇠와 다릅니다'],
    ['display name required', '표시 이름을 넣으세요'],
    ['display name too long', '표시 이름이 너무 깁니다(40자까지)'],
    ['bad hub url or key', '서버 주소 또는 키가 올바르지 않습니다'],
    ['internal error', '내부 오류가 났습니다. 다시 시도하세요'],
    ['Token has expired or is invalid', '인증번호가 만료됐거나 틀렸습니다'],
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
  assert.ok(JS.includes('var ok = !!c && !why && !sending;'), '상대가 없으면 안내 없이 잠근다(v0.3.2)');
});

test('⑭ 모듈이 준 문자열은 HTML 에 넣지 않고 textContent 로만 그린다', () => {
  assert.equal(count(JS, 'innerHTML'), 0);
  assert.equal(count(JS, 'insertAdjacentHTML'), 0);
  assert.equal(count(JS, 'outerHTML'), 0);
  // 화면 조각은 h()·icon() 두 도우미로만 만든다.
  assert.ok(JS.includes('function h(tag, attrs)') && JS.includes('function icon(name)'));
});

test('⑮ 브랜드는 Face 헤더와 같은 회전 육각 + IRIS 이고, 알림 스위치는 "켜짐" 뜻이다', () => {
  assert.ok(HTML.includes('<symbol id="i-mark"'), '회전 육각 그림');
  assert.ok(RAW_CSS.includes('@keyframes mk-spin'));
  assert.ok(RAW_CSS.includes('"Segoe Script"'), 'IRIS 글자체');
  assert.ok(count(HTML, '<span class="word">IRIS</span>') >= 4, '문 4장(본 화면 왼쪽 줄은 v0.3.2 부터 없음)');
  // 테마 이름을 CSS 색으로 읽지 않는다('black' 테마 → 검정 강조색 사고, v0.2.0). Face 의 9개 테마가 전부 표에 있다.
  assert.equal(JS.includes('CSS.supports'), false);
  for (const id of ['indigo', 'black', 'graphite', 'forest', 'ember', 'violet', 'ivory', 'mist', 'paper']) assert.ok(new RegExp(`\\b${id}: \\{ accent: '#[0-9a-f]{6}', mode: '(dark|light)' \\}`).test(JS), `테마 ${id}`);
  assert.ok(JS.includes("$('set-mute').checked = !(S && S.notifyMuted);"));
  assert.ok(JS.includes('notifyMuted: !e.target.checked'));
});
