-- =====================================================================
-- Mise à jour 23 : écrire aux coachs
--   * « Mes coachs » : chaque athlète a SA conversation avec les coachs de son équipe
--     (et le bureau). Les autres athlètes et les parents ne la voient pas.
--   * « Groupe Coachs » : tous les coachs et le bureau, pour se parler entre encadrants.
-- Remplace la mise à jour 22 (groupes « Athlètes & coachs » par équipe, abandonnés).
-- À lancer que la 22 ait été lancée ou non : celle-ci contient tout.
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

-- ---------- Le groupe : une nouvelle colonne sur les messages ----------
alter table public.messages add column if not exists grp text;
-- Les anciens groupes par équipe de la mise à jour 22 disparaissent
delete from public.messages where grp like 'coachs.%';
delete from public.chat_reads where conv like 'grp:coachs.%';
delete from public.chat_prefs where conv like 'grp:coachs.%';
alter table public.messages drop constraint if exists message_target;
alter table public.messages add constraint message_target check (
  (team_id is not null and dm_a is null and dm_b is null and grp is null) or
  (team_id is null and dm_a is not null and dm_b is not null and dm_a < dm_b and grp is null) or
  (team_id is null and dm_a is null and dm_b is null and grp ~ '^(coachs|ath\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')
);
create index if not exists messages_grp_idx on public.messages(grp, created_at);

-- Les personnes d'une conversation de groupe
--   'coachs'     : tous les coachs et le bureau
--   'ath.<id>'   : l'athlète, les coachs de son équipe et le bureau (ni les autres athlètes, ni les parents)
create or replace function public.group_people(g text) returns setof uuid
language plpgsql stable security definer set search_path = public as $$
declare a uuid; t text;
begin
  if g = 'coachs' then
    return query select id from profiles where role in ('coach', 'bureau')
      union select ct.coach_id from coach_teams ct join profiles p on p.id = ct.coach_id where p.role <> 'pending';
  elsif g ~ '^ath\.[0-9a-f-]{36}$' then
    a := substr(g, 5)::uuid;
    select team_id into t from profiles where id = a and role <> 'pending';
    return query select a where t is not null
      union select ct.coach_id from coach_teams ct join profiles p on p.id = ct.coach_id
             where ct.team_id = t and p.role <> 'pending'
      union select id from profiles where role = 'bureau';
  end if;
end $$;

-- Fait partie de la conversation
create or replace function public.in_group(g text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_member() and auth.uid() in (select group_people(g));
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

-- Vidé pour tout le monde : par le bureau, ou (conversation d'un athlète) par un coach de son équipe
create or replace function public.can_wipe_conv(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_member() and (
    (c like 'team:%' and (is_bureau() or exists(select 1 from coach_teams ct join profiles p on p.id = ct.coach_id and p.role = 'coach'
                                                 where ct.coach_id = auth.uid() and ct.team_id = substr(c, 6))))
    or (c like 'grp:%' and (is_bureau() or (c like 'grp:ath.%' and exists(select 1 from coach_teams ct join profiles p on p.id = ct.coach_id and p.role = 'coach'
                                                 join profiles a on a.team_id = ct.team_id and a.id::text = substr(c, 9)
                                                 where ct.coach_id = auth.uid()))))
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

-- ---------- Fichiers joints (dossier chat/grp/…) ----------
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
    perform push_send(array(select group_people(new.grp)),
      case when new.grp = 'coachs' then 'Groupe Coachs'
           else 'Coachs · ' || coalesce((select full_name from profiles where id::text = substr(new.grp, 5)), '') end,
      who || ' : ' || txt, './#chat=grp:' || new.grp, 'grp:' || new.grp);
  else
    perform push_send(array[case when new.sender_id = new.dm_a then new.dm_b else new.dm_a end],
      (select full_name from profiles where id = new.sender_id), txt, './#chat=dm:' || new.sender_id, 'dm:' || new.sender_id);
  end if;
  return new;
end $$;
