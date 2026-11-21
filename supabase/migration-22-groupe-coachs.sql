-- =====================================================================
-- Mise à jour 22 : groupe de tchat « Coachs »
--   Un groupe qui réunit tous les coachs et le bureau, pour se parler entre encadrants.
--   Les athlètes et les parents ne le voient pas (ils ont déjà le groupe de leur équipe
--   et les messages privés avec leurs coachs).
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

-- ---------- Le groupe : une nouvelle colonne sur les messages ----------
alter table public.messages add column if not exists grp text;
alter table public.messages drop constraint if exists message_target;
alter table public.messages add constraint message_target check (
  (team_id is not null and dm_a is null and dm_b is null and grp is null) or
  (team_id is null and dm_a is not null and dm_b is not null and dm_a < dm_b and grp is null) or
  (team_id is null and dm_a is null and dm_b is null and grp = 'coachs')
);
create index if not exists messages_grp_idx on public.messages(grp, created_at);

-- Fait partie du groupe Coachs : un coach, ou une personne du bureau
create or replace function public.in_group(g text) returns boolean
language sql stable security definer set search_path = public as $$
  select g = 'coachs' and exists(
    select 1 from profiles p where p.id = auth.uid() and p.role <> 'pending'
      and (p.role in ('coach', 'bureau') or exists(select 1 from coach_teams where coach_id = p.id)));
$$;

-- Les personnes du groupe (pour les notifications)
create or replace function public.group_people(g text) returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from profiles where g = 'coachs' and role in ('coach', 'bureau')
  union select ct.coach_id from coach_teams ct join profiles p on p.id = ct.coach_id
         where g = 'coachs' and p.role <> 'pending';
$$;

-- ---------- Lire et écrire ----------
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  (team_id is not null and team_id in (select my_team_ids()))
  or auth.uid() = dm_a or auth.uid() = dm_b
  or (grp is not null and in_group(grp))
);

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and is_member()
  and (not is_announcement or is_bureau())
  and (
    (team_id is not null and team_id in (select my_team_ids()))
    or (grp is not null and in_group(grp))
    or (team_id is null and grp is null and auth.uid() in (dm_a, dm_b)
        and can_dm_with(case when dm_a = auth.uid() then dm_b else dm_a end))
  )
);

-- ---------- « Lu par… », archiver, supprimer ----------
create or replace function public.can_see_conv(c text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if c like 'team:%' then
    return is_member() and substr(c, 6) in (select my_team_ids());
  elsif c like 'dm:%' then
    return is_member() and auth.uid()::text = any(string_to_array(substr(c, 4), '_'));
  elsif c like 'grp:%' then
    return in_group(substr(c, 5));
  end if;
  return false;
exception when others then
  return false;
end $$;

-- Le groupe Coachs ne peut être vidé pour tout le monde que par le bureau
create or replace function public.can_wipe_conv(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_member() and (
    (c like 'team:%' and (is_bureau() or exists(select 1 from coach_teams ct join profiles p on p.id = ct.coach_id and p.role = 'coach'
                                                 where ct.coach_id = auth.uid() and ct.team_id = substr(c, 6))))
    or (c like 'grp:%' and is_bureau())
    or (c like 'dm:%' and auth.uid()::text = any(string_to_array(substr(c, 4), '_'))));
$$;

create or replace function public.delete_conv(c text) returns int
language plpgsql security definer set search_path = public as $$
declare n int; ids uuid[];
begin
  if not can_wipe_conv(c) then raise exception 'Non autorisé'; end if;
  if c like 'team:%' then
    delete from messages where team_id = substr(c, 6);
  elsif c like 'grp:%' then
    delete from messages where grp = substr(c, 5);
  else
    ids := string_to_array(substr(c, 4), '_')::uuid[];
    delete from messages where dm_a = least(ids[1], ids[2]) and dm_b = greatest(ids[1], ids[2]);
  end if;
  get diagnostics n = row_count;
  delete from chat_reads where conv = c;
  delete from chat_prefs where conv = c;
  return n;
end $$;
revoke execute on function public.delete_conv(text) from public, anon;
grant execute on function public.delete_conv(text) to authenticated;

-- ---------- Fichiers joints (dossier chat/grp/coachs) ----------
create or replace function public.can_access_file(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(path, '/'); who uuid;
begin
  if parts[1] in ('avatars', 'documents', 'absences') then who := current_pid(parts[2]::uuid); end if;
  if parts[1] = 'news' then
    return is_member();
  elsif parts[1] = 'avatars' then
    return is_member() and (can_see_private(who)
      or exists(select 1 from profiles where id = who and team_id in (select my_team_ids())));
  elsif parts[1] = 'documents' then
    return can_act_for(who);
  elsif parts[1] = 'absences' then
    return can_act_for(who) or is_coach_of(who);
  elsif parts[1] = 'chat' and parts[2] = 'team' then
    return parts[3] in (select my_team_ids());
  elsif parts[1] = 'chat' and parts[2] = 'dm' then
    return auth.uid()::text = any(string_to_array(parts[3], '_'));
  elsif parts[1] = 'chat' and parts[2] = 'grp' then
    return in_group(parts[3]);
  end if;
  return false;
exception when others then
  return false;
end $$;

drop policy if exists club_files_delete_chat on storage.objects;
create policy club_files_delete_chat on storage.objects for delete to authenticated
  using (bucket_id = 'club-files' and split_part(name, '/', 1) = 'chat'
         and can_wipe_conv(case when split_part(name, '/', 2) = 'team' then 'team:' || split_part(name, '/', 3)
                                when split_part(name, '/', 2) = 'grp' then 'grp:' || split_part(name, '/', 3)
                                else 'dm:' || split_part(name, '/', 3) end));

-- ---------- Notifications ----------
create or replace function public.notify_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce((select split_part(full_name, ' ', 1) from profiles where id = new.sender_id), '');
        txt text := coalesce(nullif(new.body, ''), case when new.file_name is not null then '📎 ' || new.file_name else '' end);
        tm text;
begin
  if new.team_id is not null then
    select name into tm from teams where id = new.team_id;
    perform push_send(array(select team_people(new.team_id)),
      case when new.is_announcement then '📣 Annonce du bureau' else 'Équipe ' || coalesce(tm, new.team_id) end,
      who || ' : ' || txt, './#chat=team:' || new.team_id, 'team:' || new.team_id);
  elsif new.grp is not null then
    perform push_send(array(select group_people(new.grp)), 'Groupe Coachs',
      who || ' : ' || txt, './#chat=grp:' || new.grp, 'grp:' || new.grp);
  else
    perform push_send(array[case when new.sender_id = new.dm_a then new.dm_b else new.dm_a end],
      (select full_name from profiles where id = new.sender_id), txt, './#chat=dm:' || new.sender_id, 'dm:' || new.sender_id);
  end if;
  return new;
end $$;
