-- =====================================================================
-- Mise à jour 21 : corrections de sécurité
--   1. Un coach ne peut plus faire entrer dans son équipe un athlète d'une autre équipe
--      sans demande de changement en attente.
--   2. À l'inscription, un parent n'est plus relié tout seul à un enfant déjà inscrit :
--      une demande « Parent à relier » est envoyée au bureau.
--   3. Les dates de naissance ne sont visibles que par la personne, sa famille,
--      ses coachs et le bureau.
--   4. Seul le bureau peut changer le nom d'une personne.
--   5. Petites protections : premier compte bureau, auteur des absences.
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

-- ---------- 1. Changement d'équipe ----------
-- Le coach de l'équipe actuelle peut toujours répartir ses athlètes.
-- Le coach de la nouvelle équipe ne peut que accepter une demande en attente.
create or replace function public.set_athlete_team(a uuid, t text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  select team_id into cur from profiles where id = a;
  if not (is_bureau() or coaches_team(cur)
          or (coaches_team(t) and exists(select 1 from team_requests
                where athlete_id = a and to_team = t and status = 'pending'))) then
    raise exception 'Non autorisé';
  end if;
  if t is not null and not exists(select 1 from teams where id = t) then raise exception 'Équipe inconnue'; end if;
  perform set_config('pau.allow_team', '1', true);
  update profiles set team_id = t where id = a;
  perform set_config('pau.allow_team', '', true);
  update team_requests set status = 'accepted', decided_by = auth.uid(), decided_at = now()
   where athlete_id = a and status = 'pending' and to_team = t;
end $$;
revoke execute on function public.set_athlete_team(uuid, text) from public, anon;
grant execute on function public.set_athlete_team(uuid, text) to authenticated;

-- ---------- 2. Enfants déclarés à l'inscription ----------
-- Enfant déjà inscrit : demande au bureau (rien n'est modifié sur sa fiche).
-- Nouvel enfant : fiche créée et reliée au parent, comme avant.
create or replace function public.signup_child(p_parent uuid, p_first text, p_last text, p_birth date, p_team text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
  fn text := trim(coalesce(p_first, '')) || ' ' || trim(coalesce(p_last, ''));
begin
  if trim(coalesce(p_first, '')) = '' or trim(coalesce(p_last, '')) = '' then return null; end if;
  select id into cid from profiles
   where id <> p_parent
     and (role = 'athlete' or (role = 'pending' and (managed or wish = 'athlete')))
     and norm_name(full_name) in (norm_name(fn), norm_name(trim(p_last) || ' ' || trim(p_first)))
     and (birth_date = p_birth or birth_date is null or p_birth is null)
   order by (birth_date = p_birth) desc nulls last, created_at
   limit 1;
  if cid is not null then
    insert into link_requests (parent_id, athlete_id) values (p_parent, cid) on conflict do nothing;
    return null;
  end if;
  return attach_child(p_parent, p_first, p_last, p_birth, p_team, 'pending');
end $$;
revoke execute on function public.signup_child(uuid, text, text, date, text) from public, anon, authenticated;

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
    left(coalesce(m->>'full_name', ''), 120),
    -- Seul le tout premier compte de la base devient bureau
    case when exists(select 1 from profiles) then 'pending' else 'bureau' end,
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
        cid := signup_child(new.id, c->>'first', c->>'last', safe_date(c->>'birth'), nullif(c->>'team', ''));
        if cid is not null then
          cg := case when c->>'gender' in ('F', 'H', 'N') then c->>'gender' end;
          update parent_links set legal = coalesce((m->>'legal')::boolean, false) where parent_id = new.id and athlete_id = cid;
          insert into profile_private (id, gender, emergency_name, emergency_phone, image_consent)
          values (cid, cg, left(coalesce(m->>'emergency_name', ''), 120), left(coalesce(m->>'emergency_phone', ''), 40),
                  case when c->>'image_consent' in ('true', 'false') then (c->>'image_consent')::boolean end)
          on conflict (id) do nothing;
        end if;
      end loop;
    exception when others then null;  -- l'inscription passe quand même, le bureau complétera
    end;
  end if;
  return new;
end $$;

-- ---------- 3. Dates de naissance ----------
-- La colonne n'est plus lisible directement : l'application la demande à la fonction ci-dessous.
revoke select on public.profiles from anon, authenticated;
grant select (id, full_name, role, team_id, title, created_at, can_plan, managed, wish, photo_path, app_admin)
  on public.profiles to authenticated;

create or replace function public.visible_birth_dates()
returns table(id uuid, birth_date date)
language sql stable security definer set search_path = public as $$
  select p.id, p.birth_date from profiles p
   where p.birth_date is not null and is_member() and (is_bureau() or can_see_private(p.id));
$$;
revoke execute on function public.visible_birth_dates() from public, anon;
grant execute on function public.visible_birth_dates() to authenticated;

-- La recherche d'enfants ne renvoie plus la date de naissance des enfants des autres
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
      case when c.n like f || ' %' then substr(c.n, length(f) + 2)
           when c.n like '% ' || f then left(c.n, length(c.n) - length(f) - 1)
           when split_part(c.n, ' ', 1) like f || '%' then substr(c.n, length(split_part(c.n, ' ', 1)) + 2)
      end as rest
    from c
  )
  select m.id, m.full_name, m.team_id,
         case when is_bureau() or can_see_private(m.id) then m.birth_date end,
         coalesce(m.birth_date = p_birth, false), coalesce(m.team_id = p_team, false)
    from m
   where m.rest is not null
     and (l = ''
          or m.rest like l || '%' or l like m.rest || '%'
          or left(m.rest, 3) = left(l, 3)
          or m.birth_date = p_birth)
   order by (m.birth_date = p_birth) desc nulls last, (m.team_id = p_team) desc nulls last, m.full_name
   limit 6;
end $$;
revoke execute on function public.similar_children(text, text, date, text) from public, anon;
grant execute on function public.similar_children(text, text, date, text) to authenticated;

-- ---------- 4. Nom, rôle, équipe : seul le bureau les change ----------
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() and auth.uid() is not null then
    new.role := old.role;
    if coalesce(current_setting('pau.allow_team', true), '') <> '1' then new.team_id := old.team_id; end if;
    new.title := old.title;
    new.can_plan := old.can_plan;
    new.full_name := old.full_name;
  end if;
  return new;
end $$;

-- ---------- 5. Auteur d'une absence ou d'une réponse de déplacement ----------
create or replace function public.stamp_updated_by() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists attendance_stamp on public.attendance;
create trigger attendance_stamp before insert or update of status, reason, file_path, file_name on public.attendance
  for each row execute function public.stamp_updated_by();
drop trigger if exists trip_presence_stamp on public.trip_presence;
create trigger trip_presence_stamp before insert or update of status on public.trip_presence
  for each row execute function public.stamp_updated_by();
