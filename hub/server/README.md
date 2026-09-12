# hub/server — 자기 허브 세우기

IRIS 메신저는 공식 허브(무료 Supabase 프로젝트) 하나에 묶여 있지 않다. 누구나 이 폴더의 SQL·스크립트로 자기 자신의 Supabase 프로젝트에 같은 서버를 세울 수 있다. 모듈 설정 화면의 "서버 주소" 칸에 자기 허브 URL을 넣으면 그쪽으로 붙는다(단, 서버 주소가 다른 사용자끼리는 대화할 수 없다 — 의도된 제약, `docs/설계.md` 조각 2 참고).

## 6단계

1. **Supabase 무료 프로젝트 생성(서울 리전 권장)** — [supabase.com](https://supabase.com) → New Project → region `ap-northeast-2` (Seoul). 프로젝트 ref(URL의 `https://<ref>.supabase.co`)를 기록해 둔다.
2. **Management API PAT(개인 액세스 토큰) 발급 → `.env`** — Supabase 대시보드 → Account → Access Tokens에서 새 토큰 발급. `SUPABASE_ACCESS_TOKEN_FEYNMAN520`처럼 자기 계정 이름이 붙은 키로 secrets `.env`에 한 줄 추가한다(원본 계정은 소유자 이름을 그대로 쓴다; 이 저장소를 자기 허브로 세우는 사람은 자기 이름으로 바꿔도 된다).
3. **`hub-ref.json` 작성** — 이 폴더에 `hub-ref.json`을 만든다: `{ "ref": "<project ref>", "url": "https://<ref>.supabase.co" }`. (커밋해도 되는 공개 정보 — 공개 식별자일 뿐 비밀이 아니다.)
4. **Resend 도메인 + `IRIS_MESSENGER_MAIL_FROM`(선택)** — [resend.com](https://resend.com)에서 무료 계정을 만들고 발신 도메인을 검증한 뒤, `.env`에 `RESEND_API_KEY`와 `IRIS_MESSENGER_MAIL_FROM`(예: `iris@example.com`, 그 도메인의 검증된 주소)을 추가한다. 이 둘이 없으면 `deploy.mjs`는 Supabase 내장 메일(팀원 전용, 시간당 몇 통)로 남아 실사용에는 부족하다 — 실서비스로 쓰려면 반드시 이 단계를 채운다.
5. **`npm run deploy:hub`** — 마이그레이션(`migrations/*.sql`, 순서대로·재실행 가능)을 적용하고, Auth 설정(OTP 6자리·10분 만료·SMTP·메일 틀)을 패치하고, `module/hub.json`(`url`·`anonKey`·`schema`)을 써서 모듈이 이 허브에 붙을 수 있게 한다.
6. **`npm run verify:rls`** — 가짜 사용자 2명으로 서로의 줄을 읽어 0행인지 확인한다. RLS(행 단위 보안) 정책을 하나라도 바꿨다면 반드시 다시 돌린다.

## 서버가 아는 것 / 모르는 것

서버(허브)는 사용자의 작업 내용·과정·세션 기록을 절대 받지 않는다. 메시지는 종단간 암호화(E2EE) 암호문으로만 오간다.

| 아는 것 | 모르는 것 |
|---|---|
| 이메일 | 메시지 내용(평문) — 암호문만 저장 |
| 표시 이름 | 파일 이름·크기 — 암호문 안에 들어 있어 서버는 못 봄 |
| 공개 열쇠(public key) | 개인 열쇠·12단어 복구 문구 — 서버에 절대 전송되지 않음 |
| 연락처 관계(누가 누구와 연결돼 있는지) | 사용자의 작업 내용·작업 과정·세션 기록 |
| "누가 누구에게 언제 몇 번" 보냈는지(메타데이터) | 파일 실제 내용 |

메타데이터(마지막 줄)는 서버 운영에 필요한 최소 정보로, 자세한 사항은 `처리방침.md`(Task 13)에 명시한다.

## 참고

- 오프라인 보관 = 표 자체이며, 배달 후 30일이 지나면 서버가 자동 삭제한다(정본은 각자 PC). 1:1 전용, 그룹 대화는 2차 범위.
- `anon key`는 모듈에 배포해도 안전하다(RLS가 방어). `service role key`는 운영자 secrets에만 두고 이 폴더 어디에도 두지 않는다.
- 탈퇴(`delete_me` 함수) → `auth.users` 삭제 → 표 4(profiles·invites·contacts·messages)의 내 줄이 `on delete cascade`로 연쇄 삭제된다.
- 정책을 바꾸면 `npm run verify:rls`를 반드시 다시 돌린다(이 폴더 `AGENTS.md`).
