-- =====================================================================
-- Mise à jour 14 : le bureau fusionne deux fiches d'un même enfant saisi en double
-- À coller dans Supabase > SQL Editor > New query > Run (après la mise à jour 13)
-- =====================================================================

-- Fiches fusionnées : les photos et documents rangés sous l'ancienne fiche restent accessibles
create table if not exists public.merged_profiles (
  old_id     uuid primary key,
  new_id     uuid not null references public.profiles(id) on delete cascade,
  merged_at  timestamptz not null default now(),
  merged_by  uuid references public.profiles(id) on delete set null
);
alter table public.merged_profiles enable row level security;
drop policy if exists merged_read on public.merged_profiles;
create policy merged_read on public.merged_profiles for select to authenticated using (is_bureau());

create or replace function public.current_pid(p uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select new_id from merged_profiles where old_id = p), p);
$$;

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
  end if;
  return false;
exception when others then
  return false;
end $$;

-- Fusionne la fiche « dup » dans la fiche « keep », puis supprime « dup ».
-- Parents, présences, absences, documents, déplacements et demandes passent sur la fiche gardée.
-- Les informations vides de la fiche gardée sont complétées avec celles du doublon.
create or replace function public.merge_profiles(keep uuid, dup uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k profiles; d profiles;
begin
  if not is_bureau() then raise exception 'Réservé au bureau'; end if;
  if keep = dup then raise exception 'Choisis deux fiches différentes'; end if;
  select * into k from profiles where id = keep;
  select * into d from profiles where id = dup;
  if k.id is null or d.id is null then raise exception 'Fiche introuvable'; end if;
  if exists(select 1 from auth.users where id = dup) then
    if exists(select 1 from auth.users where id = keep) then
      raise exception 'Les deux fiches ont un compte de connexion : supprime d''abord le compte en trop dans Supabase (Authentication)';
    end if;
    raise exception 'La fiche à supprimer a un compte de connexion : garde plutôt celle-là';
  end if;
  if d.role = 'parent' or k.role = 'parent' then raise exception 'On ne fusionne que des fiches d''athlètes'; end if;

  -- Fiche
  update profiles set
    birth_date = coalesce(k.birth_date, d.birth_date),
    team_id    = coalesce(k.team_id, d.team_id),
    photo_path = coalesce(k.photo_path, d.photo_path),
    role       = case when k.role = 'pending' and d.role <> 'pending' then d.role else k.role end
   where id = keep;

  -- Coordonnées : on complète ce qui manque ; en cas de désaccord sur l'image, le refus l'emporte
  insert into profile_private (id) values (keep) on conflict (id) do nothing;
  update profile_private p set
    gender          = coalesce(p.gender, x.gender),
    phone           = case when p.phone = '' then x.phone else p.phone end,
    emergency_name  = case when p.emergency_name = '' then x.emergency_name else p.emergency_name end,
    emergency_phone = case when p.emergency_phone = '' then x.emergency_phone else p.emergency_phone end,
    image_consent   = case when p.image_consent is null then x.image_consent
                           when x.image_consent is null then p.image_consent
                           else p.image_consent and x.image_consent end
    from profile_private x where p.id = keep and x.id = dup;

  -- Parents
  insert into parent_links (parent_id, athlete_id, legal)
    select parent_id, keep, legal from parent_links where athlete_id = dup
    on conflict (parent_id, athlete_id) do update set legal = parent_links.legal or excluded.legal;

  -- Présences et absences : si les deux fiches en ont une pour le même événement, on garde la plus récente
  delete from attendance a using attendance b
   where a.athlete_id = keep and b.athlete_id = dup and a.event_id = b.event_id and b.updated_at > a.updated_at;
  update attendance set athlete_id = keep
   where athlete_id = dup and event_id not in (select event_id from attendance where athlete_id = keep);

  delete from trip_presence a using trip_presence b
   where a.athlete_id = keep and b.athlete_id = dup and a.trip_id = b.trip_id and b.updated_at > a.updated_at;
  update trip_presence set athlete_id = keep
   where athlete_id = dup and trip_id not in (select trip_id from trip_presence where athlete_id = keep);

  update trip_packed set athlete_id = keep
   where athlete_id = dup and item_id not in (select item_id from trip_packed where athlete_id = keep);

  -- Documents, demandes
  update documents set athlete_id = keep where athlete_id = dup;
  update team_requests set athlete_id = keep where athlete_id = dup;
  delete from link_requests where athlete_id = dup and status = 'pending'
     and parent_id in (select parent_id from link_requests where athlete_id = keep and status = 'pending');
  update link_requests set athlete_id = keep where athlete_id = dup;
  update link_requests set status = 'accepted', decided_by = auth.uid()
   where athlete_id = keep and status = 'pending'
     and parent_id in (select parent_id from parent_links where athlete_id = keep);

  -- On garde la trace pour les fichiers rangés sous l'ancienne fiche
  update merged_profiles set new_id = keep where new_id = dup;
  insert into merged_profiles (old_id, new_id, merged_by) values (dup, keep, auth.uid())
    on conflict (old_id) do update set new_id = keep;

  delete from profiles where id = dup;
end $$;
revoke execute on function public.merge_profiles(uuid, uuid) from public, anon;
grant execute on function public.merge_profiles(uuid, uuid) to authenticated;
