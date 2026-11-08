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
