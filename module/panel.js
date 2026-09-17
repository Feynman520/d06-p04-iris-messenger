/* IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home */
/* ─────────────────────────────────────────────────────────────────────
   화면 하나. 토큰(?t=)을 지닌 요청만 모듈 프로세스가 받아 준다.
   - 서버와 이야기하는 창구는 api() 하나뿐이다(fetch를 여기 말고 쓰지 않는다).
   - Escape는 만지지 않는다 — Face 서랍이 그 키로 닫히기 때문이다.
   - alert/confirm/prompt 대신 <dialog>를 쓴다.
   ───────────────────────────────────────────────────────────────────── */
'use strict';

var $ = function (id) { return document.getElementById(id); };
var T = new URLSearchParams(location.search).get('t') || '';
var STAGES = ['nohub', 'out', 'code', 'identity', 'in'];
// Face 테마 이름 → 강조색·밝기(P02 app/registry.js THEMES 의 --iris 와 같은 값). 이름은 색 이름이 아니라 테마 이름이다 —
// 'black' 같은 이름을 CSS 색으로 읽으면 강조색이 검정이 되어 마크·단추가 사라진다(v0.2.0 실측). 모르는 이름은 기본(indigo).
var THEMES = {
  indigo: { accent: '#8fa8ff', mode: 'dark' },
  black: { accent: '#a3b1ff', mode: 'dark' },
  graphite: { accent: '#9ecbff', mode: 'dark' },
  forest: { accent: '#7fd8a8', mode: 'dark' },
  ember: { accent: '#ffb27a', mode: 'dark' },
  violet: { accent: '#c39bff', mode: 'dark' },
  ivory: { accent: '#b0742e', mode: 'light' },
  mist: { accent: '#3b74c9', mode: 'light' },
  paper: { accent: '#3d5bd6', mode: 'light' }
};
var STATUS_LABEL = {
  pending_in: '받은 요청',
  pending_out: '상대 수락 대기',
  blocked_by_me: '내가 차단함',
  blocked_me: '상대가 차단함'
};
var RESET_WARN = "재설정하면 이 PC의 옛 편지는 다시 열 수 없고 친구들에게 '열쇠 바뀜' 경고가 갑니다";
var CONN_LABEL = { online: '연결됨', slow: '느림', offline: '끊김', stopped: '대기' };
var GROUP_GAP = 5 * 60000;   // 같은 사람의 글이 5분 안에 이어지면 한 묶음으로 붙인다

// 서버·라이브러리가 주는 영어 오류를 사람 말로 바꾼다. 모르는 말은 그대로 보여 준다(숨기지 않는다).
var ERRORS = {
  'bad email': '메일 주소 형식이 아닙니다',
  'bad code': '인증번호 또는 링크 형식이 아닙니다',
  locked: '5회 틀려 잠겼습니다. 인증번호를 다시 받으세요',
  'invalid or expired invite': '초대 코드가 틀렸거나 만료됐습니다',
  'too many attempts, wait a minute': '시도가 너무 많습니다. 1분 뒤 다시 하세요',
  'fingerprint mismatch': '고유번호가 맞지 않습니다. 코드를 다시 확인하세요(서버가 열쇠를 바꿔치기했을 수 있습니다)',
  blocked: '차단된 상대입니다',
  mismatch: '복구 단어가 이 계정의 열쇠와 다릅니다',
  'display name required': '표시 이름을 넣으세요',
  'display name too long': '표시 이름이 너무 깁니다(40자까지)',
  'bad hub url or key': '서버 주소 또는 키가 올바르지 않습니다',
  'internal error': '내부 오류가 났습니다. 다시 시도하세요',
  'Token has expired or is invalid': '인증번호가 만료됐거나 틀렸습니다',
  'bad avatar': '사진 형식이 맞지 않습니다',
  'avatar too large': '사진이 너무 큽니다'
};

function human(e) {
  var msg = (e && e.message) || String(e || '');
  if (ERRORS[msg]) return ERRORS[msg];
  if ((e && e.status === 0) || msg.indexOf('network:') === 0) return '서버에 연결할 수 없습니다';
  if (msg.toLowerCase().indexOf('expired') >= 0) return '인증번호가 만료됐거나 틀렸습니다';
  return msg;
}

var S = null;          // 마지막 state
var peer = null;       // 열린 대화 상대
var items = [];        // 열린 대화의 편지들
var es = null;
var refreshTimer = null;
var autoPicked = false;
var pendingFile = null;   // 고른 뒤 아직 보내지 않은 파일(v0.4.0: 파일은 보내기를 눌러야 나간다)
var backToEmail = false;
var sending = false;    // 보내는 중이면 입력칸·단추를 잠근다
var verifying = false;  // 인증번호 확인 중(6자리가 차면 자동으로 한 번만)

/* ── 창구 하나 ─────────────────────────────────────────────────── */
async function api(p, opt) {
  opt = opt || {};
  var url = p + (p.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(T);
  var hasBody = opt.json !== undefined || opt.raw !== undefined;
  var init = { method: opt.method || (hasBody ? 'POST' : 'GET') };
  if (opt.json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opt.json);
  } else if (opt.raw !== undefined) {
    init.body = opt.raw;
  }
  var res;
  try {
    res = await fetch(url, init);
  } catch (e) { // 모듈 프로세스가 내려갔거나 전선이 끊긴 경우
    var net = new Error('network: ' + (e && e.message ? e.message : e));
    net.status = 0;
    throw net;
  }
  var data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) {
    var err = new Error(data.error || ('요청이 실패했습니다 (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── 조각 만들기 ───────────────────────────────────────────────── */
function h(tag, attrs) {
  var n = document.createElement(tag);
  attrs = attrs || {};
  for (var k in attrs) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (var i = 2; i < arguments.length; i += 1) {
    var kid = arguments[i];
    if (!kid) continue;
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return n;
}

// 안에 담아 둔 그림 글자(<symbol>)를 꺼내 쓴다.
function icon(name) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

// 아바타: 사진(data URL)이 있으면 그림, 없으면 이름 첫 글자. cls 로 크기 변형을 고른다.
function avatarEl(name, avatar, cls) {
  var el = h('span', { class: 'avatar' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
  if (avatar && String(avatar).indexOf('data:image/jpeg;base64,') === 0) {
    var img = h('img', { alt: '' });
    img.src = avatar;
    el.appendChild(img);
  } else {
    el.textContent = initial(name);
  }
  return el;
}

// 이미 있는 아바타 칸(왼쪽 줄의 나)을 채운다: 사진이면 그림 하나, 아니면 첫 글자.
function fillAvatar(el, name, avatar) {
  el.textContent = '';
  if (avatar && String(avatar).indexOf('data:image/jpeg;base64,') === 0) {
    var img = h('img', { alt: '' });
    img.src = avatar;
    el.appendChild(img);
  } else {
    el.textContent = initial(name);
  }
}

function say(id, msg) { var el = $(id); if (el) el.textContent = msg || ''; }

function fmtTime(at) {
  try { return new Date(at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}

function fmtDay(at) {
  try {
    var d = new Date(at);
    var now = new Date();
    var same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
    if (same(d, now)) return '오늘';
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (same(d, y)) return '어제';
    return d.toLocaleDateString('ko-KR', { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  } catch (e) { return ''; }
}

function dayKey(at) {
  try { var d = new Date(at); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); } catch (e) { return ''; }
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function initial(name) {
  var s = String(name || '').trim();
  return s ? Array.from(s)[0] : '?';
}

function riskyRe() {
  try { return new RegExp((S && S.riskyExt) || '$^', 'i'); } catch (e) { return /$^/; }
}

function contactOf(id) {
  var list = (S && S.contacts) || [];
  for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  return null;
}

/* ── 테마 ──────────────────────────────────────────────────────── */
function applyTheme(t) {
  var id = t && t.id ? String(t.id) : '';
  var known = THEMES[id] || THEMES.indigo;
  // 밝기는 테마 이름이 정한다(밝은 테마 셋). Face 가 mode 를 따로 'light' 로 주면 그것도 받는다.
  var mode = known.mode === 'light' || (t && t.mode === 'light') ? 'light' : 'dark';
  document.documentElement.setAttribute('data-mode', mode);
  document.documentElement.style.setProperty('--accent', known.accent);
}

/* ── 작은 메뉴 ─────────────────────────────────────────────────── */
var openMenu = null;

function closeMenus() {
  if (!openMenu) return;
  openMenu.menu.hidden = true;
  openMenu.btn.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

function toggleMenu(btn, menu) {
  var was = openMenu && openMenu.menu === menu;
  closeMenus();
  if (was) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  openMenu = { btn: btn, menu: menu };
}

document.addEventListener('click', function (e) {
  if (!openMenu) return;
  if (openMenu.menu.contains(e.target) || openMenu.btn.contains(e.target)) return;
  closeMenus();
});

/* ── 전체 그리기 ───────────────────────────────────────────────── */
function render() {
  if (!S) return;
  applyTheme(S.theme);
  var stage = S.keyMismatch ? 'identity' : (S.stage || 'out');
  if (S.stage !== 'code') backToEmail = false;
  if (stage === 'code' && backToEmail) stage = 'out';
  for (var i = 0; i < STAGES.length; i += 1) {
    var el = $('stage-' + STAGES[i]);
    if (el) el.hidden = STAGES[i] !== stage;
  }
  // 열쇠가 어긋난 상태에서는 "시작(새 열쇠 만들기)"을 숨긴다 — 그 길도 이 PC의 옛 열쇠를 지우기 때문에,
  // 물어보지 않고 누를 수 있는 단추로 두면 안 된다. 남는 길은 ① 복구 단어 복원 ② 확인을 거친 재설정뿐.
  $('idn-mismatch').hidden = !S.keyMismatch;
  $('idn-normal').hidden = !!S.keyMismatch;
  $('idn-create').hidden = !!S.keyMismatch;
  if (S.keyMismatch) $('idn-words-wrap').hidden = false;
  // 서버에만 프로필이 없는 경우: 이 PC의 열쇠를 그대로 올리는 길을 하나 더 보여 준다(열쇠는 그대로다).
  $('idn-missing').hidden = !S.profileMissing;
  $('idn-register').hidden = !S.profileMissing;
  if (stage === 'code') { say('code-email', S.email || '메일 주소'); if (!verifying) $('code-input').focus(); }
  if (stage !== 'in') return;

  say('me-name', S.displayName || '나');
  fillAvatar($('me-avatar'), S.displayName || '나', S.avatar);
  if (!$('settings-page').hidden) paintSettings();
  paintConn();
  paintHub();
  // 서랍을 열면 곧바로 읽을 것이 보이도록 첫 수락된 친구 하나만 열어 준다(처음 한 번).
  if (!autoPicked && !peer) {
    var cs = S.contacts || [];
    for (var k = 0; k < cs.length; k += 1) {
      if (cs[k].status === 'accepted') { autoPicked = true; openPeer(cs[k].id); break; }
    }
  }
  renderContacts();
  renderPeerbar();
  paintComposer();
}

function paintConn() {
  if (!S) return;
  var c = S.connection || 'stopped';
  $('conn-dot').className = 'dot ' + c;
  say('conn-text', CONN_LABEL[c] || c);
}

function paintHub() {
  var b = $('hub-banner');
  if (!S.hubMismatch) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = S.hubMismatch === 'hub_old'
    ? '서버가 이 모듈보다 낡았습니다. 서버를 올리기 전까지는 새 글을 주고받지 않습니다.'
    : '이 모듈이 서버보다 낡았습니다. 모듈을 새로 받기 전까지는 새 글을 주고받지 않습니다.';
}

function renderContacts() {
  var box = $('contacts');
  box.textContent = '';
  var list = (S.contacts || []).slice().sort(function (a, b) {
    return String(a.displayName || '').localeCompare(String(b.displayName || ''), 'ko');
  });
  if (!list.length) {
    box.appendChild(h('li', { class: 'empty', text: '아직 친구가 없습니다. 아래 「친구 추가」를 눌러 초대 코드를 만들어 상대에게 전하세요.' }));
    return;
  }
  var unread = (S.unread && S.unread.byPeer) || {};
  list.forEach(function (c) {
    var sub = h('div', { class: 'sub' },
      h('span', { class: 'fp', text: c.fingerprint ? c.fingerprint.slice(0, 4) : '····' }),
      STATUS_LABEL[c.status] ? h('span', { class: 'tag' + (c.status === 'pending_in' ? ' warn' : ''), text: STATUS_LABEL[c.status] }) : null,
      c.keyChanged ? h('span', { class: 'tag bad', text: '⚠ 열쇠 바뀜' }) : null,
      (!c.keyChanged && c.needsVerify) ? h('span', { class: 'tag warn', text: '고유번호 재확인 필요' }) : null
    );
    var btn = h('button', {
      class: 'contact', type: 'button', 'aria-current': peer === c.id ? 'true' : 'false',
      onclick: function () { openPeer(c.id); }
    },
      avatarEl(c.displayName, c.avatar),
      h('span', { class: 'txt' }, h('span', { class: 'nm', text: c.displayName || '이름 모름' }), sub),
      unread[c.id] ? h('span', { class: 'unread', text: String(unread[c.id]) }) : null
    );
    box.appendChild(h('li', {}, btn));
  });
}

function renderPeerbar() {
  var bar = $('peerbar');
  bar.textContent = '';
  var old = document.getElementById('peer-notes');
  if (old) old.remove();
  var c = peer ? contactOf(peer) : null;
  if (!c) {
    bar.appendChild(h('div', { class: 'who' }, h('h2', { text: '대화' })));   // 안내 문구 없음(v0.3.2)
    return;
  }
  var fp = c.fingerprint || '········';
  var who = h('div', { class: 'who' },
    avatarEl(c.displayName, c.avatar),
    h('h2', { text: c.displayName || '이름 모름' }),
    h('span', { class: 'chip', title: '상대의 고유번호' }, document.createTextNode(fp.slice(0, 4)), h('b', { text: fp.slice(4) })),
    h('span', { class: 'verify', text: '상대와 직접 대조하세요. 이름은 흉내 낼 수 있지만 고유번호는 못 합니다.' })
  );
  // 지금 상황에 맞는 안내는 머리 아래 얇은 줄로(항상 보이는 설명은 위 한 문장뿐).
  var notes = h('div', { class: 'notes', id: 'peer-notes' });
  if (c.keyChanged) notes.appendChild(h('p', { class: 'bad', text: '상대의 열쇠가 바뀌었습니다. 새 고유번호를 상대에게 직접 확인한 뒤에만 받아들이세요.' }));
  if (!c.keyChanged && c.needsVerify) notes.appendChild(h('p', { class: 'warn', text: '이 열쇠는 서버에서 받아 그대로 고정한 것입니다. 고유번호를 상대에게 직접 확인한 뒤 아래 단추를 누르세요.' }));
  if (c.status === 'pending_out') notes.appendChild(h('p', { text: '상대 수락 대기 중입니다.' }));
  if (c.status === 'blocked_me') notes.appendChild(h('p', { text: '상대가 나를 차단했습니다.' }));
  if (c.status === 'blocked_by_me') notes.appendChild(h('p', { text: '내가 차단한 상대입니다. 글이 오가지 않습니다.' }));

  // 눌러야 할 것(수락·거절·새 고유번호 확인)은 단추로, 나머지(차단·풀기·삭제)는 … 메뉴로.
  var acts = h('div', { class: 'acts' });
  var btn = function (label, action, cls) {
    return h('button', { class: 'btn sm' + (cls ? ' ' + cls : ''), type: 'button', onclick: function () { contactAction(c.id, action, label); } }, label);
  };
  var item = function (label, action, ic, cls) {
    return h('button', { type: 'button', role: 'menuitem', class: cls || null, onclick: function () { closeMenus(); contactAction(c.id, action, label); } }, icon(ic), label);
  };
  if (c.keyChanged || c.needsVerify) acts.appendChild(btn('새 고유번호 확인', 'trust-key', 'danger'));
  if (c.status === 'pending_in') { acts.appendChild(btn('수락', 'accept', 'primary')); acts.appendChild(btn('거절', 'reject')); }
  var menu = h('div', { class: 'menu right', role: 'menu', hidden: true });
  if (c.status === 'accepted') { menu.appendChild(item('차단', 'block', 'block', 'danger')); menu.appendChild(item('삭제', 'remove', 'trash', 'danger')); }
  else if (c.status === 'blocked_by_me') { menu.appendChild(item('차단 풀기', 'unblock', 'block')); menu.appendChild(item('삭제', 'remove', 'trash', 'danger')); }
  else if (c.status === 'pending_out' || c.status === 'blocked_me') { menu.appendChild(item('삭제', 'remove', 'trash', 'danger')); }
  if (menu.childNodes.length) {
    var more = h('button', { class: 'ic', type: 'button', title: '더 보기', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, icon('more'));
    more.addEventListener('click', function () { toggleMenu(more, menu); });
    acts.appendChild(h('div', { class: 'menu-wrap' }, more, menu));
  }
  bar.appendChild(who);
  bar.appendChild(acts);
  if (notes.childNodes.length) bar.insertAdjacentElement('afterend', notes);
}

function renderChat() {
  var box = $('chat');
  box.textContent = '';
  if (!peer) return;   // 상대가 없으면 안내 없이 빈 화면(v0.3.2)
  if (!items.length) {
    box.appendChild(h('p', { class: 'blank', text: '아직 주고받은 글이 없습니다. 아래에 첫 글을 써 보세요.' }));
    return;
  }
  var re = riskyRe();
  var lastDay = '';
  items.forEach(function (it, i) {
    var prev = items[i - 1];
    var next = items[i + 1];
    var day = dayKey(it.at);
    if (day !== lastDay) { box.appendChild(h('div', { class: 'day', text: fmtDay(it.at) })); lastDay = day; }
    var joinPrev = !!prev && prev.dir === it.dir && dayKey(prev.at) === day && (Date.parse(it.at) - Date.parse(prev.at)) < GROUP_GAP;
    var joinNext = !!next && next.dir === it.dir && dayKey(next.at) === day && (Date.parse(next.at) - Date.parse(it.at)) < GROUP_GAP
      && !(it.dir === 'out' && it.status !== next.status);   // 보냄/실패가 갈리면 시각·상태를 따로 보여 준다
    var line = h('div', { class: 'line ' + (it.dir === 'out' ? 'out' : 'in') + (joinPrev ? '' : ' first') + (joinNext ? '' : ' last') });
    if (it.kind === 'file') line.appendChild(fileCard(it, re));
    else line.appendChild(h('div', { class: 'msg', text: it.text || '' }));
    // 시각·상태는 묶음의 마지막 글에만(같은 사람의 연속 글마다 반복하지 않는다).
    var showMeta = !joinNext || it.status === 'failed' || it.status === 'unsupported';
    if (showMeta) {
      var meta = h('div', { class: 'meta' }, h('span', { text: fmtTime(it.at) }));
      if (it.dir === 'out') {
        if (it.status === 'pending') meta.appendChild(h('span', { text: '보내는 중' }));
        else if (it.status === 'sent') meta.appendChild(h('span', { text: '보냄' }));
        else if (it.status === 'failed') meta.appendChild(h('span', { class: 'fail', text: '실패 · ' + (it.error || '까닭 모름') }));
      } else if (it.status === 'unsupported') {
        meta.appendChild(h('span', { class: 'fail', text: '이 모듈이 열 수 없는 형식입니다' }));
      }
      line.appendChild(meta);
    }
    if (it.status === 'failed' && it.kind === 'file') {
      line.appendChild(h('p', { class: 'failhint', text: '다시 보내려면 파일을 다시 첨부해 보내세요' }));
    }
    box.appendChild(line);
  });
  box.scrollTop = box.scrollHeight;
}

function fileCard(it, re) {
  var f = it.file || {};
  var wrap = document.createDocumentFragment();
  var card = h('div', { class: 'filecard' },
    h('span', { class: 'fic', 'aria-hidden': 'true' }, icon('file')),
    h('div', { class: 'ftxt' },
      h('div', { class: 'fname', text: f.name || '파일', title: f.name || '' }),
      h('div', { class: 'fsize', text: fmtSize(f.size) }))
  );
  if (!f.savedPath && it.dir === 'in' && it.status !== 'failed') {
    card.appendChild(h('div', { class: 'go' }, h('button', {
      class: 'btn sm', type: 'button',
      onclick: function (e) { getFile(it.id, e.currentTarget); }
    }, '받기')));
  }
  wrap.appendChild(card);
  if (re.test(String(f.name || ''))) {
    wrap.appendChild(h('p', { class: 'fnote risky', text: '실행되는 파일일 수 있습니다. 믿는 사람이 보낸 것만, 무엇인지 직접 물어본 뒤에 여세요.' }));
  }
  if (f.savedPath) wrap.appendChild(h('p', { class: 'fnote saved', text: f.savedPath }));
  if (it.fetchError) wrap.appendChild(h('p', { class: 'fnote risky', text: it.fetchError }));
  return wrap;
}

function paintComposer() {
  var c = peer ? contactOf(peer) : null;
  var why = '';
  if (!c) why = '';   // 상대가 없으면 안내 없이 조용히 잠근다(v0.3.2)
  else if (c.status === 'pending_in') why = '먼저 이 요청을 수락하세요.';
  else if (c.status === 'pending_out') why = '상대가 수락해야 글을 보낼 수 있습니다.';
  else if (c.status === 'blocked_by_me') why = '차단을 풀어야 보낼 수 있습니다.';
  else if (c.status === 'blocked_me') why = '상대가 차단해 보낼 수 없습니다.';
  else if (S.hubMismatch) why = '서버와 판이 맞지 않아 지금은 보낼 수 없습니다.';
  var ok = !!c && !why && !sending;
  $('msg').disabled = !ok;
  $('btn-send').disabled = !ok;
  $('btn-file').disabled = !ok;
  say('composer-why', why);
  countText();
}

// 글자 수는 상한 가까이(500자 전)부터만 보여 준다 — 평소에는 숫자가 눈에 안 띄게.
function countText() {
  var max = (S && S.limits && S.limits.textMax) || 4000;
  var n = Array.from($('msg').value).length;
  var el = $('count');
  el.textContent = n + ' / ' + max;
  el.className = 'count' + (n > max ? ' over' : '');
  el.hidden = n < max - 500;
}

/* ── 대화 열기·읽음 ────────────────────────────────────────────── */
async function openPeer(id) {
  if (peer !== id) clearAttach();   // 첨부는 고른 상대에게만 — 상대를 바꾸면 푼다
  peer = id;
  items = [];
  say('sendmsg', '');
  closeMenus();
  renderContacts();
  renderPeerbar();
  paintComposer();
  renderChat();
  try {
    var r = await api('/api/messages/' + encodeURIComponent(id));
    if (peer !== id) return;
    items = r.items || [];
    renderChat();
  } catch (e) {
    say('sendmsg', human(e));
  }
  readOpen();
}

// force=true면 state의 안 읽은 수를 보지 않고 곧장 읽음 처리한다. 새 편지가 방금 온 순간에는
// S.unread가 아직 낡아(120ms 묶음 갱신 전) 첫 통을 놓치기 때문이다. 한 번 더 부르는 건 해가 없다.
async function readOpen(force) {
  if (!peer) return;
  if (document.visibilityState !== 'visible') return;
  var by = (S && S.unread && S.unread.byPeer) || {};
  if (!force && !by[peer]) return;
  try { await api('/api/read', { json: { peer: peer } }); } catch (e) { /* 읽음 표시는 실패해도 조용히 */ }
  scheduleRefresh();
}

function upsert(item) {
  for (var i = 0; i < items.length; i += 1) {
    if (items[i].id === item.id) { items[i] = Object.assign({}, items[i], item); return; }
  }
  items.push(item);
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async function () {
    refreshTimer = null;
    try { S = await api('/api/state'); render(); } catch (e) { /* 다음 사건에 다시 */ }
  }, 120);
}

/* ── 보내기 ────────────────────────────────────────────────────── */
// 상한은 state().limits에서 온다 — 숫자를 화면에 박아 두지 않는다.
function fileMax() { return (S && S.limits && S.limits.fileMax) || 10 * 1024 * 1024; }
function tooBigText() { return '파일이 너무 큽니다(' + Math.round(fileMax() / 1048576) + 'MB)'; }

// 보내는 동안 칸과 단추를 잠근다(Enter를 두 번 눌러도 같은 글이 두 통 나가지 않게).
function lockSend(on) {
  sending = on;
  if (on) {
    $('msg').disabled = true;
    $('btn-send').disabled = true;
    $('btn-file').disabled = true;
    return;
  }
  paintComposer();                       // 상대 상태에 따라 다시 열거나 닫는다
  if (!$('msg').disabled) $('msg').focus();
}

// 첨부 띠: 고른 파일이 있으면 입력칸 위에 보이고, 없으면 숨긴다.
function renderAttach() {
  var f = pendingFile;
  $('attach').hidden = !f;
  $('attach-name').textContent = f ? f.name : '';
  $('attach-name').title = f ? f.name : '';
  $('attach-size').textContent = f ? fmtSize(f.size) : '';
  $('msg').placeholder = f ? '파일과 함께 보낼 글(비워도 됩니다)' : '글을 쓰고 Enter로 보냅니다';
}

function attachFile(file) {
  if (!file) return;
  if (file.size > fileMax()) { say('sendmsg', tooBigText()); return; }
  say('sendmsg', '');
  pendingFile = file;
  renderAttach();
  if (!$('msg').disabled) $('msg').focus();
}

function clearAttach() {
  pendingFile = null;
  renderAttach();
}

// 파일 한 통을 올린다 — 잠금(lockSend)은 부르는 쪽이 건다.
async function postFile(file) {
  var q = '/api/send-file?peer=' + encodeURIComponent(peer) + '&name=' + encodeURIComponent(file.name);
  var r = await api(q, { raw: file });
  if (r.item) { upsert(r.item); renderChat(); }
}

// 보내기(Enter·단추): 첨부가 있으면 파일 먼저, 글이 있으면 그다음 — 두 통으로 나간다.
async function sendText() {
  if (sending) return;
  var text = $('msg').value;
  var file = pendingFile;
  if (!peer || (!text.trim() && !file)) return;
  var max = (S.limits && S.limits.textMax) || 4000;
  if (text.trim() && Array.from(text).length > max) { say('sendmsg', '글이 너무 깁니다(' + max + '자)'); return; }
  say('sendmsg', '');
  lockSend(true);
  try {
    if (file) {
      say('sendmsg', '보내는 중: ' + file.name);
      await postFile(file);
      clearAttach();
      say('sendmsg', '');
    }
    if (text.trim()) {
      var r = await api('/api/send', { json: { peer: peer, text: text } });
      $('msg').value = '';
      $('msg').style.height = 'auto';
      countText();
      if (r.item) { upsert(r.item); renderChat(); }
    }
  } catch (e) {
    say('sendmsg', e.status === 413 ? tooBigText() : human(e));
  }
  lockSend(false);
}

async function getFile(id, btn) {
  btn.disabled = true;
  btn.textContent = '받는 중';
  try {
    var r = await api('/api/file/' + encodeURIComponent(id), { method: 'POST' });
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id !== id) continue;
      items[i].file = Object.assign({}, items[i].file, { savedPath: r.path });
      delete items[i].fetchError;
    }
  } catch (e) {
    for (var j = 0; j < items.length; j += 1) if (items[j].id === id) items[j].fetchError = human(e);
  }
  renderChat();
}

/* ── 친구목록 ────────────────────────────────────────────────────── */
async function contactAction(id, action, label) {
  if (action === 'remove' || action === 'block' || action === 'reject' || action === 'trust-key') {
    var text = action === 'trust-key'
      ? '상대의 새 고유번호를 받아들입니다. 상대에게 직접 물어 고유번호가 맞는지 먼저 확인했나요?'
      : '이 친구를 ' + label + '합니다. 되돌리려면 다시 초대 코드를 주고받아야 할 수 있습니다.';
    var yes = await ask(text, label);
    if (!yes) return;
  }
  try {
    await api('/api/contacts/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    if (action === 'remove' || action === 'reject') { peer = null; items = []; renderChat(); }
    scheduleRefresh();
  } catch (e) {
    say('sendmsg', human(e));
  }
}

/* ── 대화상자 도우미 ───────────────────────────────────────────── */
var askResolve = null;

function ask(text, okLabel) {
  say('confirm-text', text);
  $('confirm-yes').textContent = okLabel || '계속';
  $('confirm-dialog').returnValue = ''; // 지난번 답이 남아 있지 않게 비운다
  $('confirm-dialog').showModal();
  return new Promise(function (resolve) { askResolve = resolve; });
}

$('confirm-dialog').addEventListener('close', function () {
  var r = askResolve;
  askResolve = null;
  if (r) r($('confirm-dialog').returnValue === 'yes');
});
$('confirm-yes').addEventListener('click', function () { $('confirm-dialog').close('yes'); });
$('confirm-no').addEventListener('click', function () { $('confirm-dialog').close('no'); });

Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
  b.addEventListener('click', function () { b.closest('dialog').close(); });
});

function showWords(words) {
  var g = $('words-grid');
  g.textContent = '';
  (words || []).forEach(function (w, i) {
    g.appendChild(h('li', {}, h('i', { text: String(i + 1) }), h('span', { text: w })));
  });
  $('words-ok').checked = false;
  $('words-go').disabled = true;
  $('words-dialog').showModal();
}

$('words-ok').addEventListener('change', function (e) { $('words-go').disabled = !e.target.checked; });
$('words-go').addEventListener('click', function () { $('words-dialog').close(); });

/* ── 단계별 손잡이 ─────────────────────────────────────────────── */
$('nohub-save').addEventListener('click', async function () {
  say('nohub-err', '');
  try {
    await api('/api/settings', { json: { hubUrl: $('nohub-url').value.trim(), anonKey: $('nohub-key').value.trim() } });
    scheduleRefresh();
  } catch (e) { say('nohub-err', human(e)); }
});

$('out-agree').addEventListener('change', function (e) { $('out-send').disabled = !e.target.checked; });
$('out-send').addEventListener('click', async function () {
  say('out-err', '');
  $('out-send').disabled = true;
  try {
    await api('/api/login/email', { json: { email: $('out-email').value.trim() } });
    backToEmail = false;
    $('code-input').value = '';
    $('code-link').value = '';
    scheduleRefresh();
  } catch (e) { say('out-err', human(e)); }
  $('out-send').disabled = !$('out-agree').checked;
});

// 인증번호: 숫자 6자리 또는(접힌 칸에) 붙여 넣은 링크 주소. 6자리가 다 차면 확인을 누르지 않아도 넘어간다.
async function verifyCode() {
  if (verifying) return;
  var link = $('code-link').value.trim();
  var code = link || $('code-input').value.trim();
  if (!code) { say('code-err', '인증번호 6자리를 넣어 주세요.'); return; }
  say('code-err', '');
  verifying = true;
  $('code-go').disabled = true;
  try {
    await api('/api/login/code', { json: { email: S.email, code: code } });
    $('code-input').value = '';
    $('code-link').value = '';
    scheduleRefresh();
  } catch (e) { say('code-err', human(e)); }
  verifying = false;
  $('code-go').disabled = false;
}

$('code-go').addEventListener('click', verifyCode);
$('code-input').addEventListener('input', function (e) {
  var v = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (v !== e.target.value) e.target.value = v;
  if (v.length === 6 && !$('code-link').value.trim()) verifyCode();
});
$('code-again').addEventListener('click', async function () {
  say('code-err', '');
  $('code-again').disabled = true;
  try { await api('/api/login/email', { json: { email: S.email } }); say('code-err', '새 인증번호를 보냈습니다. 메일함을 확인하세요.'); }
  catch (e) { say('code-err', human(e)); }
  $('code-again').disabled = false;
});
$('code-back').addEventListener('click', function () { backToEmail = true; render(); });

function showWordsArea() {
  $('idn-words-wrap').hidden = false;
  $('idn-words').focus();
}

$('idn-create').addEventListener('click', async function () {
  say('idn-err', '');
  var name = $('idn-name').value.trim();
  if (!name) { say('idn-err', '상대에게 보일 이름을 적어 주세요.'); return; }
  $('idn-create').disabled = true;
  try {
    var r = await api('/api/identity', { json: { displayName: name } });
    if (r.words) showWords(r.words);
    scheduleRefresh();
  } catch (e) { say('idn-err', human(e)); }
  $('idn-create').disabled = false;
});

$('idn-register').addEventListener('click', async function () {
  say('idn-err', '');
  var name = $('idn-name').value.trim() || (S && S.displayName) || '';
  if (!name) { say('idn-err', '상대에게 보일 이름을 적어 주세요.'); return; }
  $('idn-register').disabled = true;
  try {
    await api('/api/identity/register', { json: { displayName: name } });
    scheduleRefresh();
  } catch (e) { say('idn-err', human(e)); }
  $('idn-register').disabled = false;
});

$('idn-restore').addEventListener('click', async function () {
  say('idn-err', '');
  if ($('idn-words-wrap').hidden) { showWordsArea(); return; }
  var words = $('idn-words').value.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 12) { say('idn-err', '복구 단어 12개를 띄어쓰기로 구분해 적어 주세요(지금 ' + words.length + '개).'); return; }
  $('idn-restore').disabled = true;
  try {
    await api('/api/identity', { json: { displayName: $('idn-name').value.trim(), words: words } });
    $('idn-words').value = '';
    scheduleRefresh();
  } catch (e) { say('idn-err', human(e)); }
  $('idn-restore').disabled = false;
});

$('idn-mm-restore').addEventListener('click', function () { showWordsArea(); });
$('idn-mm-reset').addEventListener('click', async function () {
  var yes = await ask(RESET_WARN, '열쇠 재설정');
  if (!yes) return;
  try {
    var r = await api('/api/identity/reset', { json: { displayName: $('idn-name').value.trim() || (S && S.displayName) || '' } });
    if (r.words) showWords(r.words);
    scheduleRefresh();
  } catch (e) { say('idn-err', human(e)); }
});

/* ── 본 화면 손잡이 ────────────────────────────────────────────── */
$('btn-plus').addEventListener('click', function () { toggleMenu($('btn-plus'), $('menu-plus')); });

$('btn-invite').addEventListener('click', async function () {
  closeMenus();
  try {
    var r = await api('/api/invite', { method: 'POST' });
    say('invite-code', r.code || '');
    $('invite-dialog').showModal();
  } catch (e) { say('sendmsg', human(e)); }
});

$('btn-accept').addEventListener('click', function () {
  closeMenus();
  say('accept-err', '');
  $('accept-input').value = '';
  $('accept-dialog').showModal();
});

$('accept-go').addEventListener('click', async function () {
  say('accept-err', '');
  $('accept-go').disabled = true;
  try {
    var r = await api('/api/invite/accept', { json: { code: $('accept-input').value.trim() } });
    $('accept-dialog').close();
    scheduleRefresh();
    if (r.id) openPeer(r.id);
  } catch (e) { say('accept-err', human(e)); }
  $('accept-go').disabled = false;
});

$('btn-file').addEventListener('click', function () { $('file-input').click(); });
$('file-input').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) attachFile(f);   // 바로 보내지 않는다 — 띠에 붙이고 보내기를 기다린다(v0.4.0)
});
$('attach-x').addEventListener('click', function () { clearAttach(); if (!$('msg').disabled) $('msg').focus(); });

$('composer').addEventListener('submit', function (e) { e.preventDefault(); sendText(); });
$('msg').addEventListener('input', function () {
  countText();
  var el = $('msg');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
});
$('msg').addEventListener('keydown', function (e) {
  // 여기서 보는 키는 Enter 하나뿐이다(서랍을 닫는 키는 우리가 손대지 않는다).
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (sending) return;   // 보내는 중에 또 누른 Enter는 버린다
  sendText();
});

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  readOpen();
  // 서랍을 다시 열었을 때 그 사이 들어온 친구 요청을 맞춘다(모듈이 최소 간격을 지키므로 여닫기마다 서버를 두드리진 않는다).
  if (S && S.stage === 'in') api('/api/contacts/sync', { method: 'POST' }).catch(function () { /* 다음 주기에 다시 */ });
});

/* ── 설정 ──────────────────────────────────────────────────────── */
// 설정은 대화 영역을 덮는 한 장. 값은 state 에서 채우고, 열려 있는 동안 state 가 바뀌면 다시 채운다(이름 칸은 편집 중이면 건드리지 않는다).
function paintSettings() {
  say('set-email', (S && S.email) || '—');
  say('set-fp', (S && S.fingerprint) || '—');
  if (document.activeElement !== $('set-name')) { $('set-name').value = (S && S.displayName) || ''; $('set-rename').hidden = true; }
  say('set-version', 'v' + ((S && S.version) || '—'));
  $('set-mute').checked = !(S && S.notifyMuted);   // 스위치는 "알림 켜짐"을 뜻한다
  // 설정의 큰 아바타는 단추 안에 그림·글자·카메라 표가 미리 들어 있다 — 통째로 비우지 않고 둘만 바꾼다.
  var av = S && S.avatar && String(S.avatar).indexOf('data:image/jpeg;base64,') === 0 ? S.avatar : null;
  if (av) $('set-avatar-img').src = av; else $('set-avatar-img').removeAttribute('src');
  $('set-avatar-img').hidden = !av;
  $('set-avatar-ini').hidden = !!av;
  $('set-avatar-ini').textContent = initial((S && S.displayName) || '나');
  $('set-avatar-remove').hidden = !av;
}

function openSettings() {
  say('set-err', '');
  paintSettings();
  $('settings-page').hidden = false;
  $('set-back').focus();
}

function closeSettings() {
  closeMenus();
  $('settings-page').hidden = true;
  if (!$('msg').disabled) $('msg').focus();
}

$('btn-settings').addEventListener('click', function () { if ($('settings-page').hidden) openSettings(); else closeSettings(); });
$('set-back').addEventListener('click', closeSettings);
$('set-name').addEventListener('input', function () { $('set-rename').hidden = $('set-name').value.trim() === ((S && S.displayName) || ''); });

/* ── 프로필 사진: PC 안에서 96×96 JPEG 로 줄여(≤ 24KB) 서버 profiles 에 넣는다 ── */
var AVATAR_PX = 96;
var AVATAR_BYTES = 24 * 1024;

function shrinkAvatar(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var c = document.createElement('canvas');
      c.width = AVATAR_PX; c.height = AVATAR_PX;
      var ctx = c.getContext('2d');
      var side = Math.min(img.naturalWidth, img.naturalHeight);
      var sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;   // 가운데 정사각형으로 자른다
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
      var q = 0.86, out = c.toDataURL('image/jpeg', q);
      while (out.length > AVATAR_BYTES && q > 0.3) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      if (out.indexOf('data:image/jpeg;base64,') !== 0 || out.length > AVATAR_BYTES) reject(new Error('사진을 줄이지 못했습니다'));
      else resolve(out);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('그림 파일이 아닙니다')); };
    img.src = url;
  });
}

$('set-avatar').addEventListener('click', function () { toggleMenu($('set-avatar'), $('menu-avatar')); });
$('set-avatar-pick').addEventListener('click', function () { closeMenus(); $('avatar-input').click(); });
$('avatar-input').addEventListener('change', async function (e) {
  var f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  say('set-err', '');
  try {
    var dataUrl = await shrinkAvatar(f);
    await api('/api/identity/avatar', { json: { avatar: dataUrl } });
    scheduleRefresh();
  } catch (err) { say('set-err', human(err)); }
});
$('set-avatar-remove').addEventListener('click', async function () {
  closeMenus();
  say('set-err', '');
  try { await api('/api/identity/avatar', { json: { avatar: null } }); scheduleRefresh(); }
  catch (err) { say('set-err', human(err)); }
});

$('set-mute').addEventListener('change', async function (e) {
  try { await api('/api/settings', { json: { notifyMuted: !e.target.checked } }); scheduleRefresh(); }
  catch (err) { say('set-err', human(err)); }
});

$('set-rename').addEventListener('click', async function () {
  say('set-err', '');
  $('set-rename').disabled = true;
  try {
    await api('/api/identity/rename', { json: { displayName: $('set-name').value.trim() } });
    say('set-err', '이름을 바꿨습니다');
    $('set-rename').hidden = true;
    scheduleRefresh();
  } catch (e) { say('set-err', human(e)); }
  $('set-rename').disabled = false;
});

// 서버 주소 칸은 v0.3.2 에서 화면에서 뺐다(사용자 결정: 일반 사용자에게 보이지 않는다). 모듈 API /api/settings 는 그대로 있다.

$('set-words').addEventListener('click', async function () {
  say('set-err', '');
  var yes = await ask('복구 단어 12개를 화면에 그대로 보여 줍니다. 옆에 다른 사람이나 화면 녹화가 없는지 먼저 확인하세요.', '보여 주기');
  if (!yes) return;
  try {
    var r = await api('/api/identity/words?confirm=1');
    showWords(r.words);
  } catch (e) { say('set-err', human(e)); }
});

$('set-reset').addEventListener('click', async function () {
  say('set-err', '');
  var yes = await ask(RESET_WARN, '열쇠 재설정');
  if (!yes) return;
  try {
    var r = await api('/api/identity/reset', { json: { displayName: (S && S.displayName) || '' } });
    if (r.words) showWords(r.words);
    scheduleRefresh();
  } catch (e) { say('set-err', human(e)); }
});

$('set-logout').addEventListener('click', async function () {
  say('set-err', '');
  var yes = await ask('이 PC에서 로그아웃합니다. 열쇠는 남아 있어 같은 계정으로 다시 들어오면 그대로 씁니다.', '로그아웃');
  if (!yes) return;
  try { await api('/api/logout', { method: 'POST' }); closeSettings(); peer = null; items = []; autoPicked = false; scheduleRefresh(); }
  catch (e) { say('set-err', human(e)); }
});

$('set-delete').addEventListener('click', async function () {
  say('set-err', '');
  var yes = await ask('메시지·열쇠·로그인 정보가 이 PC와 서버에서 지워집니다. 되돌릴 수 없습니다.', '탈퇴');
  if (!yes) return;
  try { await api('/api/delete-account', { method: 'POST' }); closeSettings(); peer = null; items = []; autoPicked = false; scheduleRefresh(); }
  catch (e) { say('set-err', human(e)); }
});

/* ── 실시간 ────────────────────────────────────────────────────── */
function connect() {
  es = new EventSource('/api/events?t=' + encodeURIComponent(T));
  es.addEventListener('state', function (e) {
    try { S = JSON.parse(e.data); } catch (err) { return; }
    render();
  });
  es.addEventListener('message', function (e) {
    var d;
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (d && d.item && d.peer === peer) {
      upsert(d.item);
      renderChat();
      if (d.item.dir === 'in' && document.visibilityState === 'visible') readOpen(true);
    }
    scheduleRefresh();
  });
  es.addEventListener('badge', function () { scheduleRefresh(); });
  es.addEventListener('connection', function (e) {
    var d;
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (S && d && d.state) { S.connection = d.state; paintConn(); }
  });
  es.onerror = function () { /* EventSource가 스스로 다시 붙는다 */ };
}

/* ── 시작 ──────────────────────────────────────────────────────── */
(async function boot() {
  try {
    S = await api('/api/state');
  } catch (e) {
    document.body.appendChild(h('main', { class: 'gate' },
      h('div', { class: 'card' },
        h('h1', { text: '화면을 열 수 없습니다' }),
        h('p', { class: 'lead', text: human(e) }),
        h('p', { class: 'hint', text: '서랍을 닫았다 다시 열어 보세요.' }))));
    return;
  }
  $('link-privacy').href = '/privacy?t=' + encodeURIComponent(T);   // 같은 문지기를 지나는 한 장
  render();
  connect();
}());
