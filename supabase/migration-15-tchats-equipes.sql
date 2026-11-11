-- =====================================================================
-- Mise à jour 15 : archiver ou supprimer une conversation,
-- et choisir les équipes actives cette saison
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

-- ---------- Équipes actives ----------
-- Une équipe inactive (pas cette saison) n'apparaît plus dans les listes, le planning ni les tchats.
-- Rien n'est supprimé : il suffit de la réactiver depuis l'Espace bureau.
do $$ begin
  if not exists(select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'teams' and column_name = 'active') then
    alter table public.teams add column active boolean not null default true;
    -- Panthers et Pom ne sont pas actives cette saison
    update public.teams set active = false where id in ('panthers', 'pom');
  end if;
end $$;

-- ---------- Préférences de chacun sur ses conversations ----------
-- archived_at : conversation rangée dans « Archivées » (elle revient si un nouveau message arrive)
-- cleared_at  : « supprimer pour moi » — les messages d'avant cette date sont masqués pour moi seulement
create table if not exists public.chat_prefs (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  conv        text not null,
  archived_at timestamptz,
  cleared_at  timestamptz,
  primary key (user_id, conv)
);
alter table public.chat_prefs enable row level security;
drop policy if exists chat_prefs_own on public.chat_prefs;
create policy chat_prefs_own on public.chat_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and can_see_conv(conv));

-- ---------- Supprimer une conversation pour tout le monde ----------
-- Groupe d'équipe : le bureau ou un coach de l'équipe. Conversation privée : l'une des deux personnes.
create or replace function public.can_wipe_conv(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_member() and (
    (c like 'team:%' and (is_bureau() or exists(select 1 from coach_teams ct join profiles p on p.id = ct.coach_id and p.role = 'coach'
                                                 where ct.coach_id = auth.uid() and ct.team_id = substr(c, 6))))
    or (c like 'dm:%' and auth.uid()::text = any(string_to_array(substr(c, 4), '_'))));
$$;

create or replace function public.delete_conv(c text) returns int
language plpgsql security definer set search_path = public as $$
declare n int; ids uuid[];
begin
  if not can_wipe_conv(c) then raise exception 'Non autorisé'; end if;
  if c like 'team:%' then
    delete from messages where team_id = substr(c, 6);
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

-- Les fichiers d'une conversation peuvent être effacés par ceux qui la suppriment pour tout le monde
drop policy if exists club_files_delete_chat on storage.objects;
create policy club_files_delete_chat on storage.objects for delete to authenticated
  using (bucket_id = 'club-files' and split_part(name, '/', 1) = 'chat'
         and can_wipe_conv(case when split_part(name, '/', 2) = 'team' then 'team:' || split_part(name, '/', 3)
                                else 'dm:' || split_part(name, '/', 3) end));

-- ---------- Présence des coachs ----------
-- Les coachs sont présents par défaut ; ils peuvent indiquer leur absence comme les athlètes.
-- Une absence de coach est visible par les membres des équipes concernées.
create or replace function public.is_coach_absence_visible(e uuid, c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_member() and exists(
    select 1 from coach_teams ct join event_teams et on et.team_id = ct.team_id and et.event_id = e
     where ct.coach_id = c and et.team_id in (select my_team_ids()));
$$;
drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance for select to authenticated
  using (can_act_for(athlete_id) or is_coach_of(athlete_id) or is_coach_absence_visible(event_id, athlete_id));
