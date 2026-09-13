-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
-- 0004_avatar: 프로필 사진(선택) 칸. 재실행 가능(idempotent). 스키마 판은 그대로 1 — 빈 칸 하나가 늘 뿐이라
-- 옛 모듈(칸을 모름)도 그대로 돈다. 사진은 모듈이 PC 안에서 96×96 JPEG 로 줄여 data URL 로 넣는다(≤ 32KB).
-- 서버는 이 값을 이름과 같은 등급으로 본다(처리방침 "수집하는 것"에 명시). 읽기 범위는 profiles_select 정책 그대로
-- (나 + 연락처를 맺은 상대), 쓰기는 profiles_update(본인만).
alter table public.profiles add column if not exists avatar text;
alter table public.profiles drop constraint if exists profiles_avatar_shape;
alter table public.profiles add constraint profiles_avatar_shape
  check (avatar is null or (length(avatar) <= 32768 and avatar like 'data:image/jpeg;base64,%'));
