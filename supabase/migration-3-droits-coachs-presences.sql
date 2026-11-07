-- =====================================================================
-- Mise à jour n°3 :
--   * droit « gérer le planning et les déplacements » (le bureau l'a toujours,
--     il peut le donner à d'autres membres)
--   * rôle « coach » relié à une ou plusieurs équipes
--   * présence / absence aux entraînements, avec justificatif
--   * trajets : date et heure d'arrivée (bus, puis avion, puis bus…)
-- À coller dans Supabase > SQL Editor > New query > Run (une seule fois)
-- =====================================================================
alter table public.profiles add column if not exists can_plan boolean not null default false;

-- Nouveau rôle « coach »
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('pending','athlete','parent','coach','bureau'));

create table if not exists public.coach_teams (
  coach_id uuid not null references public.profiles(id) on delete cascade,
  team_id  text not null references public.teams(id) on delete cascade,
  primary key (coach_id, team_id)
);
alter table public.coach_teams enable row level security;
drop policy if exists coach_teams_read on public.coach_teams;
create policy coach_teams_read on public.coach_teams for select to authenticated using (is_member());
drop policy if exists coach_teams_write on public.coach_teams;
create policy coach_teams_write on public.coach_teams for all to authenticated using (is_bureau()) with check (is_bureau());

-- Les coachs voient le planning et le tchat de leurs équipes
create or replace function public.my_team_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select id from teams where is_bureau()
  union
  select team_id from profiles where id = auth.uid() and role = 'athlete' and team_id is not null
  union
  select p.team_id from parent_links l join profiles p on p.id = l.athlete_id
   where l.parent_id = auth.uid() and p.team_id is not null
  union
  select team_id from coach_teams where coach_id = auth.uid()
     and exists(select 1 from profiles where id = auth.uid() and role = 'coach');
$$;

-- Le coach d'un athlète (coach de son équipe)
create or replace function public.is_coach_of(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from coach_teams ct join profiles p on p.team_id = ct.team_id
                 join profiles c on c.id = ct.coach_id and c.role = 'coach'
                where ct.coach_id = auth.uid() and p.id = a);
$$;

-- Présence aux entraînements (et compétitions)
create table if not exists public.attendance (
  event_id   uuid not null references public.events(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  status     text not null check (status in ('present','absent')),
  reason     text not null default '',
  file_path  text,
  file_name  text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (event_id, athlete_id)
);
alter table public.attendance enable row level security;
drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance for select to authenticated
  using (can_act_for(athlete_id) or is_coach_of(athlete_id));
drop policy if exists attendance_write on public.attendance;
create policy attendance_write on public.attendance for all to authenticated
  using (can_act_for(athlete_id)) with check (can_act_for(athlete_id));

-- Justificatifs d'absence : absences/<athlete_id>/<fichier>, visibles aussi par le coach
create or replace function public.can_access_file(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(path, '/');
begin
  if parts[1] = 'documents' then
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

create or replace function public.is_planner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and (role = 'bureau' or (can_plan and role <> 'pending')));
$$;

-- Les personnes qui gèrent le planning voient tous les événements et déplacements
create or replace function public.can_see_event(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_planner() or exists(
    select 1 from event_teams where event_id = e and team_id in (select my_team_ids()));
$$;

-- Seul le bureau peut donner ce droit
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() and auth.uid() is not null then
    new.role := old.role;
    new.team_id := old.team_id;
    new.title := old.title;
    new.can_plan := old.can_plan;
  end if;
  return new;
end $$;

drop policy if exists events_write on public.events;
create policy events_write on public.events for all to authenticated using (is_planner()) with check (is_planner());
drop policy if exists event_teams_write on public.event_teams;
create policy event_teams_write on public.event_teams for all to authenticated using (is_planner()) with check (is_planner());
drop policy if exists trips_write on public.trips;
create policy trips_write on public.trips for all to authenticated using (is_planner()) with check (is_planner());
drop policy if exists steps_write on public.trip_steps;
create policy steps_write on public.trip_steps for all to authenticated using (is_planner()) with check (is_planner());
drop policy if exists items_write on public.trip_items;
create policy items_write on public.trip_items for all to authenticated using (is_planner()) with check (is_planner());
drop policy if exists legs_write on public.trip_legs;
create policy legs_write on public.trip_legs for all to authenticated using (is_planner()) with check (is_planner());

-- Trajets : date et heure d'arrivée
alter table public.trip_legs add column if not exists arrive_day date;
alter table public.trip_legs add column if not exists arrive_time time;
