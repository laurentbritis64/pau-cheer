-- =====================================================================
-- Rattrapage : mises à jour 6, 8, 9, 10, 11, 12, 13 et 14 en une seule fois
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être lancé même si certaines de ces mises à jour sont déjà passées.
-- (La mise à jour 7, les horaires, n'est pas incluse : elle est déjà faite.)
-- =====================================================================

-- >>>>>>>>>> migration-6-enfants-presences.sql
-- =====================================================================
-- Mise à jour 6 : enfants sans compte, inscription des parents,
-- présence par défaut et nombre de présents
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Un enfant peut exister sans compte (il n'a pas de téléphone) : ses parents agissent pour lui
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();
alter table public.profiles add column if not exists birth_date date;
alter table public.profiles add column if not exists managed boolean not null default false;  -- enfant sans compte
alter table public.profiles add column if not exists wish text;                               -- demande à l'inscription : athlete / parent

-- Un compte supprimé dans Supabase supprime aussi son profil
create or replace function public.handle_deleted_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from profiles where id = old.id;
  return old;
end $$;
drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted after delete on auth.users
  for each row execute function public.handle_deleted_user();

-- La liste des équipes est visible sur l'écran d'inscription
drop policy if exists teams_read_anon on public.teams;
create policy teams_read_anon on public.teams for select to anon using (true);

-- Outils
create or replace function public.norm_name(t text) returns text
language sql immutable as $$ select regexp_replace(lower(trim(coalesce(t, ''))), '\s+', ' ', 'g') $$;

create or replace function public.safe_date(t text) returns date
language plpgsql immutable as $$
begin
  return nullif(trim(t), '')::date;
exception when others then
  return null;
end $$;

-- Relie un enfant à un parent. Si l'enfant existe déjà (même prénom, nom et date de naissance,
-- par exemple inscrit par l'autre parent), le parent est relié au même enfant.
create or replace function public.attach_child(p_parent uuid, p_first text, p_last text, p_birth date, p_team text, p_role text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
  fn text := trim(coalesce(p_first, '')) || ' ' || trim(coalesce(p_last, ''));
begin
  if trim(coalesce(p_first, '')) = '' or trim(coalesce(p_last, '')) = '' then return null; end if;
  if p_team is not null and not exists(select 1 from teams where id = p_team) then p_team := null; end if;
  select id into cid from profiles
   where id <> p_parent
     and (role = 'athlete' or (role = 'pending' and (managed or wish = 'athlete')))
     and norm_name(full_name) in (norm_name(fn), norm_name(trim(p_last) || ' ' || trim(p_first)))
     and (birth_date = p_birth or birth_date is null or p_birth is null)
   order by (birth_date = p_birth) desc nulls last, created_at
   limit 1;
  if cid is null then
    insert into profiles (full_name, role, team_id, birth_date, managed)
    values (fn, p_role, p_team, p_birth, true) returning id into cid;
  else
    update profiles set birth_date = coalesce(birth_date, p_birth),
                        team_id = case when role = 'pending' then coalesce(team_id, p_team) else team_id end
     where id = cid;
  end if;
  insert into parent_links (parent_id, athlete_id) values (p_parent, cid) on conflict do nothing;
  return cid;
end $$;
revoke execute on function public.attach_child(uuid, text, text, date, text, text) from public, anon, authenticated;

-- Le bureau ajoute un enfant à un parent depuis sa fiche
create or replace function public.add_child(p_parent uuid, p_first text, p_last text, p_birth date, p_team text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() then raise exception 'Réservé au bureau'; end if;
  return attach_child(p_parent, p_first, p_last, p_birth, p_team, 'athlete');
end $$;
revoke execute on function public.add_child(uuid, text, text, date, text) from public, anon;
grant execute on function public.add_child(uuid, text, text, date, text) to authenticated;

-- Inscription : athlète (date de naissance, équipe) ou parent (avec ses enfants)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  kind text := m->>'kind';
  tm text := nullif(m->>'team', '');
  c jsonb;
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
  insert into profile_private (id, email) values (new.id, new.email);
  if kind = 'parent' and jsonb_typeof(m->'children') = 'array' then
    begin
      for c in select * from jsonb_array_elements(m->'children') loop
        n := n + 1; exit when n > 8;
        perform attach_child(new.id, c->>'first', c->>'last', safe_date(c->>'birth'), nullif(c->>'team', ''), 'pending');
      end loop;
    exception when others then null;  -- l'inscription passe quand même, le bureau reliera les enfants
    end;
  end if;
  return new;
end $$;

-- Un parent pas encore validé par le bureau n'a encore aucun droit sur l'enfant
create or replace function public.can_act_for(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a = auth.uid()
      or is_bureau()
      or (is_member() and exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a));
$$;

create or replace function public.my_team_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select id from teams where is_bureau()
  union
  select team_id from profiles where id = auth.uid() and role = 'athlete' and team_id is not null
  union
  select p.team_id from parent_links l join profiles p on p.id = l.athlete_id
   where l.parent_id = auth.uid() and p.team_id is not null and p.role = 'athlete' and is_member()
  union
  select team_id from coach_teams where coach_id = auth.uid()
     and exists(select 1 from profiles where id = auth.uid() and role = 'coach');
$$;

-- Nombre de présents : tout le monde est présent sauf les absences déclarées
create or replace function public.attendance_summary(ids uuid[])
returns table(event_id uuid, total int, absent int)
language sql stable security definer set search_path = public as $$
  select e.id,
    (select count(*) from profiles p join event_teams et on et.team_id = p.team_id and et.event_id = e.id
      where p.role = 'athlete')::int,
    (select count(*) from attendance a join profiles p on p.id = a.athlete_id and p.role = 'athlete'
       join event_teams et on et.event_id = e.id and et.team_id = p.team_id
      where a.event_id = e.id and a.status = 'absent')::int
  from unnest(ids) as e(id)
  where is_member() and can_see_event(e.id);
$$;
revoke execute on function public.attendance_summary(uuid[]) from public, anon;
grant execute on function public.attendance_summary(uuid[]) to authenticated;

-- >>>>>>>>>> migration-8-coordonnees.sql
-- =====================================================================
-- Mise à jour 8 : sexe, téléphones, responsable légal, contact d'urgence
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Coordonnées (fiche privée) : visibles par la personne, ses parents, ses coachs et le bureau
alter table public.profile_private add column if not exists gender text check (gender in ('F', 'H'));
alter table public.profile_private add column if not exists phone text not null default '';
alter table public.profile_private add column if not exists emergency_name text not null default '';
alter table public.profile_private add column if not exists emergency_phone text not null default '';

-- Responsable légal de l'enfant
alter table public.parent_links add column if not exists legal boolean not null default false;

-- Qui peut lire une fiche privée
create or replace function public.can_see_private(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p = auth.uid()
      or is_bureau()
      or can_act_for(p)
      or is_coach_of(p)
      -- le coach voit aussi les parents de ses athlètes
      or exists(select 1 from parent_links l where l.parent_id = p and is_coach_of(l.athlete_id))
      -- un parent voit l'autre parent de son enfant
      or exists(select 1 from parent_links a join parent_links b on a.athlete_id = b.athlete_id
                 where a.parent_id = auth.uid() and b.parent_id = p and is_member());
$$;

drop policy if exists private_read on public.profile_private;
create policy private_read on public.profile_private for select to authenticated using (can_see_private(id));
drop policy if exists private_insert on public.profile_private;
create policy private_insert on public.profile_private for insert to authenticated with check (can_act_for(id));
drop policy if exists private_update on public.profile_private;
create policy private_update on public.profile_private for update to authenticated
  using (can_act_for(id)) with check (can_act_for(id));

-- Un parent ne peut pas changer l'e-mail de connexion enregistré
create or replace function public.protect_private() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() and auth.uid() is not null and tg_op = 'UPDATE' then
    new.email := old.email;
  end if;
  return new;
end $$;
drop trigger if exists private_protect on public.profile_private;
create trigger private_protect before update on public.profile_private
  for each row execute function public.protect_private();

-- Un parent indique s'il est responsable légal de son enfant
create or replace function public.set_legal_guardian(a uuid, v boolean) returns void
language sql security definer set search_path = public as $$
  update parent_links set legal = v where parent_id = auth.uid() and athlete_id = a and is_member();
$$;
revoke execute on function public.set_legal_guardian(uuid, boolean) from public, anon;
grant execute on function public.set_legal_guardian(uuid, boolean) to authenticated;

-- Inscription : on enregistre aussi sexe, téléphone, contact d'urgence et responsable légal
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
  insert into profile_private (id, email, gender, phone, emergency_name, emergency_phone)
  values (new.id, new.email, g, left(coalesce(m->>'phone', ''), 40),
          left(coalesce(m->>'emergency_name', ''), 120), left(coalesce(m->>'emergency_phone', ''), 40));
  if kind = 'parent' and jsonb_typeof(m->'children') = 'array' then
    begin
      for c in select * from jsonb_array_elements(m->'children') loop
        n := n + 1; exit when n > 8;
        cid := attach_child(new.id, c->>'first', c->>'last', safe_date(c->>'birth'), nullif(c->>'team', ''), 'pending');
        if cid is not null then
          cg := case when c->>'gender' in ('F', 'H') then c->>'gender' end;
          update parent_links set legal = coalesce((m->>'legal')::boolean, false) where parent_id = new.id and athlete_id = cid;
          insert into profile_private (id, gender, emergency_name, emergency_phone)
          values (cid, cg, left(coalesce(m->>'emergency_name', ''), 120), left(coalesce(m->>'emergency_phone', ''), 40))
          on conflict (id) do update set
            gender = coalesce(profile_private.gender, excluded.gender),
            emergency_name = case when profile_private.emergency_name = '' then excluded.emergency_name else profile_private.emergency_name end,
            emergency_phone = case when profile_private.emergency_phone = '' then excluded.emergency_phone else profile_private.emergency_phone end;
        end if;
      end loop;
    exception when others then null;  -- l'inscription passe quand même, le bureau complétera
    end;
  end if;
  return new;
end $$;

-- Les enfants sans compte ont aussi une fiche privée
insert into public.profile_private (id) select id from public.profiles on conflict (id) do nothing;

-- >>>>>>>>>> migration-9-bureau-athlete-photos.sql
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


-- >>>>>>>>>> migration-10-sans-genre.sql
-- =====================================================================
-- Mise à jour 10 : choix « sans genre », ajout de ses enfants depuis « Mon compte », changements d'équipe
-- À coller dans Supabase > SQL Editor > New query > Run (après les mises à jour 8 et 9)
-- =====================================================================
alter table public.profile_private drop constraint if exists profile_private_gender_check;
alter table public.profile_private add constraint profile_private_gender_check check (gender in ('F', 'H', 'N'));

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  kind text := m->>'kind';
  tm text := nullif(m->>'team', '');
  g text := case when m->>'gender' in ('F', 'H', 'N') then m->>'gender' end;
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
          cg := case when c->>'gender' in ('F', 'H', 'N') then c->>'gender' end;
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


-- ---------- Ajouter ses enfants depuis « Mon compte » ----------
-- Le bureau ajoute un enfant à n'importe quel parent (et peut se l'ajouter à lui-même).
-- Un parent validé peut ajouter un nouvel enfant à son compte : l'enfant attend la validation du bureau.
-- Si l'enfant existe déjà (inscrit par l'autre parent), c'est le bureau qui fait le lien.
create or replace function public.add_child(p_parent uuid, p_first text, p_last text, p_birth date, p_team text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; fresh boolean;
begin
  if is_bureau() then
    return attach_child(p_parent, p_first, p_last, p_birth, p_team, 'athlete');
  end if;
  if p_parent <> auth.uid() or not is_member() then raise exception 'Non autorisé'; end if;
  cid := attach_child(p_parent, p_first, p_last, p_birth, p_team, 'pending');
  select created_at = now() into fresh from profiles where id = cid;
  if not coalesce(fresh, false) then
    raise exception 'Cet enfant est déjà inscrit : demande au bureau de te relier à lui.';
  end if;
  return cid;
end $$;
revoke execute on function public.add_child(uuid, text, text, date, text) from public, anon;
grant execute on function public.add_child(uuid, text, text, date, text) to authenticated;

-- ---------- Changements d'équipe ----------
-- Seules les fonctions ci-dessous (et le bureau) peuvent changer l'équipe d'un athlète
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() and auth.uid() is not null then
    new.role := old.role;
    if coalesce(current_setting('pau.allow_team', true), '') <> '1' then new.team_id := old.team_id; end if;
    new.title := old.title;
    new.can_plan := old.can_plan;
  end if;
  return new;
end $$;

-- Coach d'une équipe donnée
create or replace function public.coaches_team(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from coach_teams ct join profiles c on c.id = ct.coach_id and c.role = 'coach'
                 where ct.coach_id = auth.uid() and ct.team_id = t);
$$;

-- Le coach (de l'équipe actuelle ou de la nouvelle) ou le bureau change l'équipe d'un athlète
create or replace function public.set_athlete_team(a uuid, t text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  select team_id into cur from profiles where id = a;
  if not (is_bureau() or coaches_team(cur) or coaches_team(t)) then raise exception 'Non autorisé'; end if;
  if t is not null and not exists(select 1 from teams where id = t) then raise exception 'Équipe inconnue'; end if;
  perform set_config('pau.allow_team', '1', true);
  update profiles set team_id = t where id = a;
  perform set_config('pau.allow_team', '', true);
  update team_requests set status = 'accepted', decided_by = auth.uid(), decided_at = now()
   where athlete_id = a and status = 'pending' and to_team = t;
end $$;
revoke execute on function public.set_athlete_team(uuid, text) from public, anon;
grant execute on function public.set_athlete_team(uuid, text) to authenticated;

-- Demandes de changement d'équipe faites par l'athlète ou son parent
create table if not exists public.team_requests (
  id           uuid primary key default gen_random_uuid(),
  athlete_id   uuid not null references public.profiles(id) on delete cascade,
  from_team    text references public.teams(id) on delete set null,
  to_team      text not null references public.teams(id) on delete cascade,
  message      text not null default '',
  requested_by uuid references public.profiles(id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'refused', 'cancelled')),
  decided_by   uuid references public.profiles(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.team_requests enable row level security;
drop policy if exists team_requests_read on public.team_requests;
create policy team_requests_read on public.team_requests for select to authenticated
  using (can_act_for(athlete_id) or coaches_team(to_team) or coaches_team(from_team));
drop policy if exists team_requests_insert on public.team_requests;
create policy team_requests_insert on public.team_requests for insert to authenticated
  with check (is_member() and can_act_for(athlete_id) and requested_by = auth.uid() and status = 'pending');
-- L'athlète ou son parent peut annuler sa demande
drop policy if exists team_requests_cancel on public.team_requests;
create policy team_requests_cancel on public.team_requests for update to authenticated
  using (can_act_for(athlete_id) and status = 'pending') with check (status = 'cancelled');

-- Le coach de la nouvelle équipe (ou le bureau) accepte ou refuse
create or replace function public.decide_team_request(r uuid, ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare q team_requests;
begin
  select * into q from team_requests where id = r and status = 'pending';
  if q.id is null then raise exception 'Demande introuvable'; end if;
  if not (is_bureau() or coaches_team(q.to_team)) then raise exception 'Non autorisé'; end if;
  if ok then
    perform set_athlete_team(q.athlete_id, q.to_team);
  else
    update team_requests set status = 'refused', decided_by = auth.uid(), decided_at = now() where id = r;
  end if;
end $$;
revoke execute on function public.decide_team_request(uuid, boolean) from public, anon;
grant execute on function public.decide_team_request(uuid, boolean) to authenticated;

-- >>>>>>>>>> migration-11-categories.sql
-- =====================================================================
-- Mise à jour 11 : nouvelles catégories d'événements (camp / stage, événement club)
-- et horaire « à confirmer »
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('train', 'comp', 'camp', 'event'));
alter table public.events add column if not exists no_time boolean not null default false;  -- horaire à confirmer (mis par défaut de 14h00 à 17h00)

-- >>>>>>>>>> migration-12-lu.sql
-- =====================================================================
-- Mise à jour 12 : savoir si un message a été lu (« Vu », « Lu par… »)
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Dernière lecture de chaque personne dans chaque conversation
-- conv : 'team:<équipe>' ou 'dm:<id1>_<id2>' (les deux id dans l'ordre)
create table if not exists public.chat_reads (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  conv     text not null,
  read_at  timestamptz not null default now(),
  primary key (user_id, conv)
);
alter table public.chat_reads enable row level security;

-- Peut voir cette conversation
create or replace function public.can_see_conv(c text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if c like 'team:%' then
    return is_member() and substr(c, 6) in (select my_team_ids());
  elsif c like 'dm:%' then
    return is_member() and auth.uid()::text = any(string_to_array(substr(c, 4), '_'));
  end if;
  return false;
exception when others then
  return false;
end $$;

drop policy if exists chat_reads_read on public.chat_reads;
create policy chat_reads_read on public.chat_reads for select to authenticated using (can_see_conv(conv));

-- Chacun enregistre seulement sa propre lecture
create or replace function public.mark_read(c text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_see_conv(c) then return; end if;
  insert into chat_reads (user_id, conv, read_at) values (auth.uid(), c, now())
  on conflict (user_id, conv) do update set read_at = greatest(chat_reads.read_at, excluded.read_at);
end $$;
revoke execute on function public.mark_read(text) from public, anon;
grant execute on function public.mark_read(text) to authenticated;

-- Mise à jour en direct
do $$ begin
  alter publication supabase_realtime add table public.chat_reads;
exception when others then null;
end $$;

-- >>>>>>>>>> migration-13-enfants-doublons.sql
-- =====================================================================
-- Mise à jour 13 : retirer un enfant ajouté par erreur,
-- repérer un enfant déjà inscrit (même prénom, nom qui commence pareil,
-- même date de naissance ou même équipe) et demander à y être relié
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Texte simplifié pour comparer les noms : minuscules, sans accents ni tirets
create or replace function public.plain(t text) returns text
language sql immutable as $$
  select regexp_replace(translate(lower(trim(coalesce(t, ''))),
    'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ-''',
    'aaaaaaceeeeiiiinooooouuuuyyoa  '), '\s+', ' ', 'g')
$$;

-- ---------- Enfants qui ressemblent à celui qu'on veut ajouter ----------
create or replace function public.similar_children(p_first text, p_last text, p_birth date, p_team text)
returns table(id uuid, full_name text, team_id text, birth_date date, same_birth boolean, same_team boolean)
language plpgsql stable security definer set search_path = public as $$
declare f text := plain(p_first); l text := plain(p_last);
begin
  if not is_member() or length(f) < 2 then return; end if;
  return query
  with c as (
    select p.*, plain(p.full_name) as n from profiles p
     where p.id <> auth.uid()
       and (p.role = 'athlete' or p.managed or (p.role = 'pending' and p.wish = 'athlete')
            or (p.role in ('bureau', 'coach') and p.team_id is not null))
       and not exists(select 1 from parent_links k where k.parent_id = auth.uid() and k.athlete_id = p.id)
  ), m as (
    select c.*,
      -- le reste du nom une fois le prénom retiré (au début ou à la fin)
      case when c.n like f || ' %' then substr(c.n, length(f) + 2)
           when c.n like '% ' || f then left(c.n, length(c.n) - length(f) - 1)
           when split_part(c.n, ' ', 1) like f || '%' then substr(c.n, length(split_part(c.n, ' ', 1)) + 2)
      end as rest
    from c
  )
  select m.id, m.full_name, m.team_id, m.birth_date,
         coalesce(m.birth_date = p_birth, false), coalesce(m.team_id = p_team, false)
    from m
   where m.rest is not null
     and (l = ''                                              -- nom pas saisi
          or m.rest like l || '%' or l like m.rest || '%'      -- nom saisi en partie
          or left(m.rest, 3) = left(l, 3)                      -- début du nom identique
          or m.birth_date = p_birth)                           -- même date de naissance
   order by (m.birth_date = p_birth) desc nulls last, (m.team_id = p_team) desc nulls last, m.full_name
   limit 6;
end $$;
revoke execute on function public.similar_children(text, text, date, text) from public, anon;
grant execute on function public.similar_children(text, text, date, text) to authenticated;

-- ---------- Demandes pour être relié à un enfant déjà inscrit ----------
create table if not exists public.link_requests (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid not null references public.profiles(id) on delete cascade,
  athlete_id  uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'refused', 'cancelled')),
  created_at  timestamptz not null default now(),
  decided_by  uuid references public.profiles(id) on delete set null
);
create unique index if not exists link_requests_one_pending on public.link_requests(parent_id, athlete_id) where status = 'pending';
alter table public.link_requests enable row level security;
drop policy if exists link_requests_read on public.link_requests;
create policy link_requests_read on public.link_requests for select to authenticated
  using (parent_id = auth.uid() or is_bureau());

-- Le bureau relie tout de suite, un parent envoie une demande au bureau
create or replace function public.request_link(a uuid) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not is_member() then raise exception 'Non autorisé'; end if;
  if a = auth.uid() or not exists(select 1 from profiles where id = a and role <> 'parent') then raise exception 'Enfant introuvable'; end if;
  if exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a) then return 'linked'; end if;
  if is_bureau() then
    insert into parent_links (parent_id, athlete_id) values (auth.uid(), a) on conflict do nothing;
    return 'linked';
  end if;
  insert into link_requests (parent_id, athlete_id) values (auth.uid(), a) on conflict do nothing;
  return 'requested';
end $$;
revoke execute on function public.request_link(uuid) from public, anon;
grant execute on function public.request_link(uuid) to authenticated;

create or replace function public.decide_link_request(r uuid, ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare q link_requests;
begin
  select * into q from link_requests where id = r;
  if q.id is null then raise exception 'Demande introuvable'; end if;
  if q.parent_id = auth.uid() and not ok then  -- le parent annule sa propre demande
    update link_requests set status = 'cancelled' where id = r and status = 'pending';
    return;
  end if;
  if not is_bureau() then raise exception 'Réservé au bureau'; end if;
  if ok then
    insert into parent_links (parent_id, athlete_id) values (q.parent_id, q.athlete_id) on conflict do nothing;
  end if;
  update link_requests set status = case when ok then 'accepted' else 'refused' end, decided_by = auth.uid()
   where id = r and status = 'pending';
end $$;
revoke execute on function public.decide_link_request(uuid, boolean) from public, anon;
grant execute on function public.decide_link_request(uuid, boolean) to authenticated;

-- ---------- Retirer un enfant ajouté par erreur ----------
-- Enfant sans compte et sans autre parent : il est supprimé.
-- Sinon (l'autre parent l'a aussi, ou l'enfant a son propre compte) : on retire seulement le lien.
create or replace function public.remove_child(a uuid) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not is_member() then raise exception 'Non autorisé'; end if;
  if not exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a) then
    raise exception 'Cet enfant n''est pas relié à ton compte';
  end if;
  if exists(select 1 from profiles where id = a and managed)
     and not exists(select 1 from parent_links where athlete_id = a and parent_id <> auth.uid())
     and not exists(select 1 from auth.users where id = a) then
    delete from profiles where id = a;
    return 'deleted';
  end if;
  delete from parent_links where parent_id = auth.uid() and athlete_id = a;
  return 'unlinked';
end $$;
revoke execute on function public.remove_child(uuid) from public, anon;
grant execute on function public.remove_child(uuid) to authenticated;

-- >>>>>>>>>> migration-14-fusion.sql
-- =====================================================================
-- Mise à jour 14 : le bureau fusionne deux fiches d'un même enfant saisi en double
-- À coller dans Supabase > SQL Editor > New query > Run (après la mise à jour 13)
-- Peut être relancée sans risque.
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
    -- nom saisi en partie (« Chloé Dub ») : on prend le nom complet du doublon
    full_name  = case when trim(k.full_name) = '' then d.full_name
                      when length(plain(d.full_name)) > length(plain(k.full_name))
                       and plain(d.full_name) like plain(k.full_name) || '%' then d.full_name
                      else k.full_name end,
    title      = coalesce(nullif(k.title, ''), d.title),
    birth_date = coalesce(k.birth_date, d.birth_date),
    team_id    = coalesce(k.team_id, d.team_id),
    photo_path = coalesce(k.photo_path, d.photo_path),
    role       = case when k.role = 'pending' and d.role <> 'pending' then d.role else k.role end
   where id = keep;

  -- Coordonnées : on complète ce qui manque ; en cas de désaccord sur l'image, le refus l'emporte
  insert into profile_private (id) values (keep) on conflict (id) do nothing;
  update profile_private p set
    email           = coalesce(nullif(p.email, ''), x.email),
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
