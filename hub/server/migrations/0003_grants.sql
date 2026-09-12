-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
-- 0003_grants: 내부 전용 함수의 기본 실행 권한 회수 + 쓰지 않는 삭제 정책 제거. 재실행 가능(idempotent).
-- 까닭: Supabase는 public 스키마에 새로 만든 함수의 EXECUTE 권한을 anon·authenticated 에게 기본으로 준다.
-- `revoke ... from public`(PUBLIC 가상 롤)만으로는 그 기본 권한이 사라지지 않아, 로그인한 아무 사용자나
-- 내부 전용 함수를 부를 수 있었다(2026-09-13 라이브 탐침 실측: rpc cleanup → 200 실행됨,
-- rpc note_invite_attempt → 함수 본문까지 실행되어 23503). 두 함수는 사용자가 부를 일이 없다.

-- ① 청소 함수: pg_cron 이 postgres 롤로 부르므로(스케줄 소유자) 회수해도 자동 청소는 그대로 돈다.
--    운영 스크립트(ops/daily.mjs --cleanup)도 Management API = postgres 경로라 영향 없다.
revoke all on function public.cleanup() from public, anon, authenticated;

-- ② 초대 시도 기록 도우미: accept_invite·lookup_invite(security definer) 안에서만 쓰인다.
revoke all on function public.note_invite_attempt(uuid) from public, anon, authenticated;

-- ③ 1차 범위에는 "메시지 삭제" 기능이 없다 — 쓰지 않는 삭제 경로는 열어 두지 않는다.
--    (보관 정리는 서버의 cleanup() 과 탈퇴 시 cascade 가 맡는다.)
drop policy if exists messages_delete on public.messages;

-- ---------- meta: 강화 적용 표식 ----------
insert into public.meta(key, value) values ('hardening', '0003') on conflict (key) do update set value = excluded.value;
