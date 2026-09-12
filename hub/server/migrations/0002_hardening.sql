-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
-- 0002_hardening: respond_contact 차단 우회 방지 · 초대 코드 추측 스로틀(공용) · 파일 메시지 소유권 검사. 재실행 가능(idempotent). 0001_init.sql은 수정하지 않음(이미 배포됨).

-- ---------- 1) respond_contact: 상대가 건 차단을 같은 유저가 unblock 없이 block 재호출로 뒤엎지 못하게 ----------
create or replace function public.respond_contact(p_other uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); r public.contacts%rowtype;
begin
  if v_me is null then raise exception 'not signed in'; end if;
  select * into r from public.contacts where user_a = least(v_me, p_other) and user_b = greatest(v_me, p_other);
  if r.user_a is null then raise exception 'no such contact'; end if;
  if p_action = 'accept' then
    if r.status <> 'pending' or r.requested_by = v_me then raise exception 'nothing to accept'; end if;
    update public.contacts set status = 'accepted', updated_at = now() where user_a = r.user_a and user_b = r.user_b;
    return 'accepted';
  elsif p_action = 'reject' then
    if r.status <> 'pending' then raise exception 'not pending'; end if;
    delete from public.contacts where user_a = r.user_a and user_b = r.user_b;
    return 'deleted';
  elsif p_action = 'block' then
    if r.status = 'blocked' and r.blocked_by <> v_me then raise exception 'blocked by the other party'; end if;
    update public.contacts set status = 'blocked', blocked_by = v_me, updated_at = now() where user_a = r.user_a and user_b = r.user_b;
    return 'blocked';
  elsif p_action = 'unblock' then
    if r.status <> 'blocked' or r.blocked_by <> v_me then raise exception 'not blocked by you'; end if;
    update public.contacts set status = 'accepted', blocked_by = null, updated_at = now() where user_a = r.user_a and user_b = r.user_b;
    return 'accepted';
  elsif p_action = 'remove' then
    delete from public.contacts where user_a = r.user_a and user_b = r.user_b;
    return 'deleted';
  end if;
  raise exception 'unknown action';
end $$;
revoke all on function public.respond_contact(uuid, text) from public;
grant execute on function public.respond_contact(uuid, text) to authenticated;

-- ---------- 2) 초대 코드 추측 방지: 시도 기록 표 + 내부 전용 도우미 + accept_invite/lookup_invite 재작성 ----------
create table if not exists public.invite_attempts (
  id bigserial primary key,
  caller uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists invite_attempts_caller_at_idx on public.invite_attempts(caller, at);
alter table public.invite_attempts enable row level security;
revoke all on public.invite_attempts from anon, authenticated;

create or replace function public.note_invite_attempt(v_me uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.invite_attempts(caller) values (v_me);
  select count(*) into n from public.invite_attempts where caller = v_me and at > now() - interval '1 minute';
  return n;
end $$;
revoke all on function public.note_invite_attempt(uuid) from public;

create or replace function public.accept_invite(p_code text)
returns table (other_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_me uuid := auth.uid(); v_status text; n int;
begin
  if v_me is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.profiles where id = v_me) then raise exception 'profile missing'; end if;
  n := public.note_invite_attempt(v_me);
  if n > 10 then
    return query select null::uuid, 'rate_limited'::text;
    return;
  end if;
  update public.invites set used_by = v_me, used_at = now()
    where code = upper(p_code) and used_by is null and expires_at > now() and owner <> v_me
    returning owner into v_owner;
  if v_owner is null then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;
  select c.status into v_status from public.contacts c where c.user_a = least(v_me, v_owner) and c.user_b = greatest(v_me, v_owner);
  if v_status = 'blocked' then
    return query select v_owner, 'blocked'::text;
    return;
  end if;
  if v_status is null then
    insert into public.contacts(user_a, user_b, status, requested_by) values (least(v_me, v_owner), greatest(v_me, v_owner), 'pending', v_me);
    v_status := 'pending';
  end if;
  return query select v_owner, v_status;
end $$;
revoke all on function public.accept_invite(text) from public;
grant execute on function public.accept_invite(text) to authenticated;

create or replace function public.lookup_invite(p_code text)
returns table (owner_id uuid, display_name text, public_key text, key_version int)
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  n := public.note_invite_attempt(auth.uid());
  if n > 10 then raise exception 'rate limited'; end if;
  return query
    select p.id, p.display_name, p.public_key, p.key_version
    from public.invites i join public.profiles p on p.id = i.owner
    where i.code = upper(p_code) and i.used_by is null and i.expires_at > now() and i.owner <> auth.uid();
end $$;
revoke all on function public.lookup_invite(text) from public;
grant execute on function public.lookup_invite(text) to authenticated;

-- cleanup(): 반환 타입에 attempts_deleted 추가 → create or replace 로는 반환 타입을 못 바꾸므로 drop 후 재생성
drop function if exists public.cleanup();
create function public.cleanup() returns table (messages_deleted int, invites_deleted int, attempts_deleted int)
language plpgsql security definer set search_path = public as $$
declare m int; i int; a int;
begin
  delete from public.messages where delivered_at is not null and delivered_at < now() - interval '30 days';
  get diagnostics m = row_count;
  delete from public.invites where expires_at < now() - interval '1 day';
  get diagnostics i = row_count;
  delete from public.invite_attempts where at < now() - interval '1 hour';
  get diagnostics a = row_count;
  return query select m, i, a;
end $$;
revoke all on function public.cleanup() from public;

-- ---------- 3) messages: file_path가 보낸 사람 소유 폴더인지 검사 + kind/file_path 정합성 표 제약 ----------
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.pair_status(sender, recipient) = 'accepted'
    and (file_path is null or file_path like sender::text || '/%'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_file_path') then
    alter table public.messages add constraint messages_kind_file_path
      check ((kind = 'text' and file_path is null) or (kind = 'file' and file_path is not null));
  end if;
end $$;

-- ---------- meta: 강화 적용 표식(스키마 버전은 '1' 유지 — accept_invite 상태값 확장 외 클라이언트 계약 불변, 클라이언트 코드 아직 없음) ----------
insert into public.meta(key, value) values ('hardening', '0002') on conflict (key) do update set value = excluded.value;
