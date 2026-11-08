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
