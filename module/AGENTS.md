# module — Face에 꽂는 메신저 클라이언트

Face `modules\messenger\`에 복사되는 쪽. 화면·배지·파일 첨부만 담고, 로그인·열쇠·연결·연락처는 `..\hub\client`를 가져다 쓴다. 본체와는 계약 v1(stdio)로만 대화한다.

- 화면은 세 조각 — `panel.html`(뼈대) · `panel.css`(스타일) · `panel.js`(동작) — 을 `panel.mjs`가 한 장으로 조립해 내준다(`<!--@css-->`·`<!--@js-->` 자리). 바깥 자원 0·토큰 문지기·CSP는 그대로다. 화면만 보려면 `node scripts/panel-preview.mjs --stage=in|out|code|identity --mode=dark|light`.
- 브랜드(회전 육각 + IRIS)는 Face 헤더(P02 `app/registry.js`)와 같은 그림·글꼴 규칙을 복사한 것이다. Face 쪽이 바뀌면 여기도 맞춘다.

<!-- 상위 AGENTS.md 규칙 재서술 금지 -->
