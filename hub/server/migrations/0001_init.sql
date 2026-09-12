-- IRIS Messenger · © 2026 Sejun Ham (함세준) · MIT · https://feynman520.github.io/card/#home
-- 0001_init: 표 5 · RLS · 함수 6 · Storage 버킷/정책 · Realtime publication · pg_cron 청소. 재실행 가능(idempotent).
create extension if not exists pgcrypto;

-- ---------- 표 ----------
create table if not exists public.meta (
  key text primary key,
  value text not null
);
insert into public.meta(key, value) values ('schema_version', '1') on conflict (key) do update set value = excluded.value;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  public_key text not null check (char_length(public_key) = 44),
  key_version int not null default 1 check (key_version >= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.invites (
  code text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  owner uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz
);
create index if not exists invites_owner_idx on public.invites(owner);

create table if not exists public.contacts (
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'blocked')),
  requested_by uuid not null,
  blocked_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index if not exists contacts_b_idx on public.contacts(user_b);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique,
  sender uuid not null references auth.users(id) on delete cascade,
  recipient uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('text', 'file')),
  body text not null check (char_length(body) <= 40000),
  file_path text check (file_path is null or char_length(file_path) <= 120),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  check (sender <> recipient)
);
create index if not exists messages_inbox_idx on public.messages(recipient, delivered_at, created_at);
create index if not exists messages_sender_idx on public.messages(sender, created_at);

-- ---------- 도우미 ----------
create or replace function public.pair_status(p_a uuid, p_b uuid) returns text
language sql stable security definer set search_path = public as $$
  select c.status from public.contacts c
  where c.user_a = least(p_a, p_b) and c.user_b = greatest(p_a, p_b)
$$;
revoke all on function public.pair_status(uuid, uuid) from public;
grant execute on function public.pair_status(uuid, uuid) to authenticated;

-- ---------- RLS ----------
alter table public.meta enable row level security;
alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.contacts enable row level security;
alter table public.messages enable row level security;

drop policy if exists meta_read on public.meta;
create policy meta_read on public.meta for select to anon, authenticated using (true);

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.pair_status(auth.uid(), id) in ('pending', 'accepted'));
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select to authenticated using (owner = auth.uid());
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete to authenticated using (owner = auth.uid());

drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts for select to authenticated using (auth.uid() in (user_a, user_b));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (auth.uid() in (sender, recipient));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.pair_status(sender, recipient) = 'accepted');
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated using (sender = auth.uid());

-- ---------- 함수(SECURITY DEFINER) ----------
create or replace function public.create_invite() returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'profile missing'; end if;
  delete from public.invites where owner = auth.uid() and used_by is null and expires_at < now();
  select count(*) into n from public.invites where owner = auth.uid() and used_by is null;
  if n >= 10 then raise exception 'too many open invites (max 10)'; end if;
  loop
    v_code := '';
    for i in 1..8 loop v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1); end loop;
    begin
      insert into public.invites(code, owner) values (v_code, auth.uid());
      return v_code;
    exception when unique_violation then null; end;
  end loop;
end $$;
revoke all on function public.create_invite() from public;
grant execute on function public.create_invite() to authenticated;

create or replace function public.lookup_invite(p_code text)
returns table (owner_id uuid, display_name text, public_key text, key_version int)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return query
    select p.id, p.display_name, p.public_key, p.key_version
    from public.invites i join public.profiles p on p.id = i.owner
    where i.code = upper(p_code) and i.used_by is null and i.expires_at > now() and i.owner <> auth.uid();
end $$;
revoke all on function public.lookup_invite(text) from public;
grant execute on function public.lookup_invite(text) to authenticated;

create or replace function public.accept_invite(p_code text)
returns table (other_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_me uuid := auth.uid(); v_recent int; v_status text;
begin
  if v_me is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.profiles where id = v_me) then raise exception 'profile missing'; end if;
  select count(*) into v_recent from public.invites where used_by = v_me and used_at > now() - interval '1 minute';
  if v_recent >= 5 then raise exception 'rate limited (5/min)'; end if;
  update public.invites set used_by = v_me, used_at = now()
    where code = upper(p_code) and used_by is null and expires_at > now() and owner <> v_me
    returning owner into v_owner;
  if v_owner is null then raise exception 'invalid or expired invite'; end if;
  select c.status into v_status from public.contacts c where c.user_a = least(v_me, v_owner) and c.user_b = greatest(v_me, v_owner);
  if v_status = 'blocked' then raise exception 'blocked'; end if;
  if v_status is null then
    insert into public.contacts(user_a, user_b, status, requested_by) values (least(v_me, v_owner), greatest(v_me, v_owner), 'pending', v_me);
    v_status := 'pending';
  end if;
  return query select v_owner, v_status;
end $$;
revoke all on function public.accept_invite(text) from public;
grant execute on function public.accept_invite(text) to authenticated;

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

create or replace function public.mark_delivered(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update public.messages set delivered_at = now() where recipient = auth.uid() and delivered_at is null and id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.mark_delivered(uuid[]) from public;
grant execute on function public.mark_delivered(uuid[]) to authenticated;

create or replace function public.delete_me() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_me() from public;
grant execute on function public.delete_me() to authenticated;

create or replace function public.cleanup() returns table (messages_deleted int, invites_deleted int)
language plpgsql security definer set search_path = public as $$
declare m int; i int;
begin
  delete from public.messages where delivered_at is not null and delivered_at < now() - interval '30 days';
  get diagnostics m = row_count;
  delete from public.invites where expires_at < now() - interval '1 day';
  get diagnostics i = row_count;
  return query select m, i;
end $$;
revoke all on function public.cleanup() from public;

-- ---------- Storage ----------
insert into storage.buckets (id, name, public, file_size_limit)
  values ('files', 'files', false, 10485760)
  on conflict (id) do update set public = false, file_size_limit = 10485760;
drop policy if exists files_insert on storage.objects;
create policy files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists files_select on storage.objects;
create policy files_select on storage.objects for select to authenticated
  using (bucket_id = 'files' and ((storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.messages m where m.file_path = storage.objects.name and m.recipient = auth.uid())));
drop policy if exists files_delete on storage.objects;
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Realtime ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ---------- 청소(pg_cron, 매일 03:17 UTC) ----------
create extension if not exists pg_cron;
do $$ begin
  if exists (select 1 from cron.job where jobname = 'iris-messenger-cleanup') then perform cron.unschedule('iris-messenger-cleanup'); end if;
  perform cron.schedule('iris-messenger-cleanup', '17 3 * * *', 'select public.cleanup()');
end $$;
