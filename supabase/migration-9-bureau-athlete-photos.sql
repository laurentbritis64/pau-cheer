-- =====================================================================
-- Mise à jour 9 : un membre du bureau ou un coach peut aussi être athlète,
-- et chaque athlète peut avoir une photo
-- À coller dans Supabase > SQL Editor > New query > Run (après la mise à jour 8)
-- =====================================================================

create or replace function public.my_team_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select id from teams where is_bureau()
  union
  select team_id from profiles where id = auth.uid() and role in ('athlete', 'bureau', 'coach') and team_id is not null
  union
  select p.team_id from parent_links l join profiles p on p.id = l.athlete_id
   where l.parent_id = auth.uid() and p.team_id is not null and p.role in ('athlete', 'bureau', 'coach') and is_member()
  union
  select team_id from coach_teams where coach_id = auth.uid()
     and exists(select 1 from profiles where id = auth.uid() and role = 'coach');
$$;

create or replace function public.attendance_summary(ids uuid[])
returns table(event_id uuid, total int, absent int)
language sql stable security definer set search_path = public as $$
  select e.id,
    (select count(*) from profiles p join event_teams et on et.team_id = p.team_id and et.event_id = e.id
      where p.role in ('athlete', 'bureau', 'coach'))::int,
    (select count(*) from attendance a join profiles p on p.id = a.athlete_id and p.role in ('athlete', 'bureau', 'coach')
       join event_teams et on et.event_id = e.id and et.team_id = p.team_id
      where a.event_id = e.id and a.status = 'absent')::int
  from unnest(ids) as e(id)
  where is_member() and can_see_event(e.id);
$$;

create or replace function public.can_dm_with(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_bureau()
  or exists(select 1 from profiles where id = o and role = 'bureau')
  or exists(select 1 from coach_teams ct join profiles c on c.id = ct.coach_id and c.role = 'coach'
             where ct.coach_id = o and ct.team_id in (select my_team_ids()))
  or exists(select 1 from coach_teams ct join profiles m on m.id = ct.coach_id and m.role = 'coach'
             where ct.coach_id = auth.uid() and (
               exists(select 1 from profiles a where a.id = o and a.role in ('athlete', 'bureau', 'coach') and a.team_id = ct.team_id)
               or exists(select 1 from parent_links l join profiles a on a.id = l.athlete_id
                          where l.parent_id = o and a.team_id = ct.team_id)));
$$;

-- ---------- Photos ----------
alter table public.profiles add column if not exists photo_path text;

-- La personne, ses parents ou le bureau changent la photo
create or replace function public.set_photo(a uuid, p text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member() or not can_act_for(a) then raise exception 'Non autorisé'; end if;
  if p is not null and p not like 'avatars/' || a::text || '/%' then raise exception 'Chemin invalide'; end if;
  update profiles set photo_path = p where id = a;
end $$;
revoke execute on function public.set_photo(uuid, text) from public, anon;
grant execute on function public.set_photo(uuid, text) to authenticated;

-- Photos : avatars/<id>/<fichier>, visibles par le bureau, les coachs, la famille et l'équipe
create or replace function public.can_access_file(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(path, '/');
begin
  if parts[1] = 'news' then
    return is_member();
  elsif parts[1] = 'avatars' then
    return is_member() and (can_see_private(parts[2]::uuid)
      or exists(select 1 from profiles where id = parts[2]::uuid and team_id in (select my_team_ids())));
  elsif parts[1] = 'documents' then
    return can_act_for(parts[2]::uuid);
  elsif parts[1] = 'absences' then
    return can_act_for(parts[2]::uuid) or is_coach_of(parts[2]::uuid);
  elsif parts[1] = 'chat' and parts[2] = 'team' then
    return parts[3] in (select my_team_ids());
  elsif parts[1] = 'chat' and parts[2] = 'dm' then
    return auth.uid()::text = any(string_to_array(parts[3], '_'));
  end if;
  return false;
exception when others then
  return false;
end $$;

drop policy if exists club_files_insert on storage.objects;
create policy club_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'club-files' and is_member() and can_access_file(name)
              and (split_part(name, '/', 1) <> 'news' or is_bureau())
              and (split_part(name, '/', 1) <> 'avatars' or can_act_for(split_part(name, '/', 2)::uuid)));

-- ---------- Droit à l'image ----------
-- null : pas encore répondu, true : accepte la publication, false : refuse (réseaux sociaux, site, presse…)
alter table public.profile_private add column if not exists image_consent boolean;

-- Inscription : le choix est enregistré pour la personne et pour chacun de ses enfants
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  kind text := m->>'kind';
  tm text := nullif(m->>'team', '');
  g text := case when m->>'gender' in ('F', 'H') then m->>'gender' end;
  c jsonb;
  cid uuid;
  cg text;
  n int := 0;
begin
  if kind not in ('athlete', 'parent') then kind := null; end if;
  if tm is not null and not exists(select 1 from teams where id = tm) then tm := null; end if;
  insert into profiles (id, full_name, role, wish, birth_date, team_id)
  values (
    new.id,
    coalesce(m->>'full_name', ''),
    case when exists(select 1 from profiles where role = 'bureau') then 'pending' else 'bureau' end,
    kind,
    case when kind = 'athlete' then safe_date(m->>'birth_date') end,
    case when kind = 'athlete' then tm end
  );
  insert into profile_private (id, email, gender, phone, emergency_name, emergency_phone, image_consent)
  values (new.id, new.email, g, left(coalesce(m->>'phone', ''), 40),
          left(coalesce(m->>'emergency_name', ''), 120), left(coalesce(m->>'emergency_phone', ''), 40),
          case when m->>'image_consent' in ('true', 'false') then (m->>'image_consent')::boolean end);
  if kind = 'parent' and jsonb_typeof(m->'children') = 'array' then
    begin
      for c in select * from jsonb_array_elements(m->'children') loop
        n := n + 1; exit when n > 8;
        cid := attach_child(new.id, c->>'first', c->>'last', safe_date(c->>'birth'), nullif(c->>'team', ''), 'pending');
        if cid is not null then
          cg := case when c->>'gender' in ('F', 'H') then c->>'gender' end;
          update parent_links set legal = coalesce((m->>'legal')::boolean, false) where parent_id = new.id and athlete_id = cid;
          insert into profile_private (id, gender, emergency_name, emergency_phone, image_consent)
          values (cid, cg, left(coalesce(m->>'emergency_name', ''), 120), left(coalesce(m->>'emergency_phone', ''), 40),
                  case when c->>'image_consent' in ('true', 'false') then (c->>'image_consent')::boolean end)
          on conflict (id) do update set
            gender = coalesce(profile_private.gender, excluded.gender),
            image_consent = coalesce(profile_private.image_consent, excluded.image_consent),
            emergency_name = case when profile_private.emergency_name = '' then excluded.emergency_name else profile_private.emergency_name end,
            emergency_phone = case when profile_private.emergency_phone = '' then excluded.emergency_phone else profile_private.emergency_phone end;
        end if;
      end loop;
    exception when others then null;  -- l'inscription passe quand même, le bureau complétera
    end;
  end if;
  return new;
end $$;

