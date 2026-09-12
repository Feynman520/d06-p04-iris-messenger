<!-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home -->

# 보안 정책 (Security Policy)

## 취약점 신고

보안 취약점을 발견했다면 **비공개로** 알려 주세요. 두 경로가 있습니다.

1. **GitHub Security Advisories(권장)** — 이 저장소의 "Security" 탭 → "Report a vulnerability"에서 비공개 보고서를 작성합니다. 저자와 신고자만 볼 수 있으며, 고쳐질 때까지 공개되지 않습니다.
2. **GitHub Issues** — Security Advisories를 쓸 수 없는 경우, [저자 GitHub 프로필](https://github.com/Feynman520)을 통해 연락하거나 이 저장소에 이슈를 남겨 주세요. 민감한 내용(공격 재현 방법 등)은 이슈 본문에 바로 적지 말고, 신고를 원한다는 사실만 남기면 비공개 채널로 안내해 드립니다.

**이메일 신고 창구는 별도로 두지 않습니다.** 위 두 GitHub 경로만 사용해 주세요.

## 범위

이 저장소(`d06-p04-iris-messenger`)의 코드가 대상입니다: `module/`(Face에 꽂는 클라이언트) · `hub/client/`(로그인·E2EE 열쇠·연결 공용 라이브러리) · `hub/server/`(Supabase 스키마·RLS·운영 스크립트) · 빌드·배포 스크립트(`scripts/`).

범위 밖: IRIS-Face 본체 자체(별도 저장소 `d06-p02-iris-face`에 신고) · 사용자가 직접 세운 자기 허브의 운영 실수(예: SMTP 키 유출) — 다만 그 원인이 이 저장소의 문서·기본값에 있다면 이 저장소의 문제로 다룹니다.

## 서명 열쇠 폐기 절차(요약)

모듈 릴리스 zip은 Ed25519 서명 열쇠로 서명됩니다. 이 열쇠가 유출되었다고 판단되면:

1. 새 서명 열쇠 쌍을 만든다.
2. IRIS-Face의 새 버전에 새 공개 열쇠와 함께 "폐기된 옛 공개 열쇠" 목록을 반영해 배포한다 — 폐기 목록에 있는 열쇠로 서명된 zip은 이후 "폐기됨 ⚠"으로 표시되고 기본적으로 설치가 거부된다.
3. 이 저장소의 모든 릴리스를 새 열쇠로 재서명해 다시 올린다.
4. GitHub Security Advisory로 유출 사실과 영향을 받는 버전 범위를 공지한다.

서명 개인 열쇠는 운영자 secrets에만 있으며 이 저장소 어디에도 커밋되지 않습니다.
