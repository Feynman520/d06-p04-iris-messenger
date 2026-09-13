// IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
// 화면 조립기: panel.html(뼈대) 안의 <!--@css--> · <!--@js--> 자리에 panel.css · panel.js 를 끼워
// 한 장의 HTML로 만든다. 서버는 이 한 장만 내주므로(토큰 문지기·CSP 그대로) 바깥 자원은 여전히 0이다.
import fs from 'node:fs';
import path from 'node:path';

export const PARTS = ['panel.html', 'panel.css', 'panel.js'];

/** 세 파일을 읽어 합친 HTML. 하나라도 없으면 throw(호출자가 자리표시자로 대신한다). */
export function loadPanel(dir) {
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return assemble(read('panel.html'), read('panel.css'), read('panel.js'));
}

export function assemble(html, css, js) {
  if (!html.includes('<!--@css-->') || !html.includes('<!--@js-->')) throw new Error('panel.html has no @css/@js slots');
  // 동작 코드 안에 </script> 가 있으면 HTML 이 거기서 끊긴다 — 조립 단계에서 막는다.
  if (/<\/script/i.test(js)) throw new Error('panel.js must not contain </script>');
  if (/<\/style/i.test(css)) throw new Error('panel.css must not contain </style>');
  return html.replace('<!--@css-->', () => css.trimEnd()).replace('<!--@js-->', () => js.trimEnd());
}
