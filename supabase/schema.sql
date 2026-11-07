-- =====================================================================
-- Pau Cheerleading : base de données de l'application
-- À coller une seule fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- Équipes ----------
create table if not exists public.teams (
  id        text primary key,
  name      text not null,
  color     text not null default '#888888',
  position  int  not null default 0
);

-- ---------- Profils (un par compte) ----------
-- role : 'pending' (en attente de validation par le bureau), 'athlete', 'parent', 'bureau'
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null default '',
  role       text not null default 'pending' check (role in ('pending','athlete','parent','bureau')),
  team_id    text references public.teams(id) on delete set null,
  title      text,
  created_at timestamptz not null default now()
);

-- Adresse e-mail : visible seulement par la personne et le bureau
create table if not exists public.profile_private (
  id    uuid primary key references public.profiles(id) on delete cascade,
  email text
);

-- Lien parent -> enfant (un parent peut avoir plusieurs enfants, un enfant 1 ou 2 parents)
create table if not exists public.parent_links (
  parent_id  uuid not null references public.profiles(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  primary key (parent_id, athlete_id)
);

-- ---------- Planning ----------
create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  type       text not null check (type in ('train','comp')),
  title      text not null,
  date       date not null,
  start_time time not null,
  end_time   time not null,
  place      text not null default '',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists events_date_idx on public.events(date);

create table if not exists public.event_teams (
  event_id uuid not null references public.events(id) on delete cascade,
  team_id  text not null references public.teams(id) on delete cascade,
  primary key (event_id, team_id)
);

-- ---------- Déplacements ----------
create table if not exists public.trips (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null unique references public.events(id) on delete cascade,
  transport    text not null default '',
  depart_place text not null default '',
  depart_time  time,
  return_time  text not null default '',
  contact      text not null default ''
);
create table if not exists public.trip_steps (
  id      uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  time    time not null,
  label   text not null
);
create table if not exists public.trip_items (
  id       uuid primary key default gen_random_uuid(),
  trip_id  uuid not null references public.trips(id) on delete cascade,
  label    text not null,
  position int not null default 0
);
create table if not exists public.trip_presence (
  trip_id    uuid not null references public.trips(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  status     text not null check (status in ('yes','no')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (trip_id, athlete_id)
);
create table if not exists public.trip_packed (
  item_id    uuid not null references public.trip_items(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  primary key (item_id, athlete_id)
);

-- ---------- Messages ----------
-- Soit un tchat d'équipe (team_id), soit une conversation privée (dm_a, dm_b)
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  team_id         text references public.teams(id) on delete cascade,
  dm_a            uuid references public.profiles(id) on delete cascade,
  dm_b            uuid references public.profiles(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  body            text not null default '',
  is_announcement boolean not null default false,
  file_path       text,
  file_name       text,
  file_size       bigint,
  file_type       text,
  created_at      timestamptz not null default now(),
  constraint message_target check (
    (team_id is not null and dm_a is null and dm_b is null) or
    (team_id is null and dm_a is not null and dm_b is not null and dm_a < dm_b)
  )
);
create index if not exists messages_team_idx on public.messages(team_id, created_at);
create index if not exists messages_dm_idx on public.messages(dm_a, dm_b, created_at);

-- ---------- Documents des athlètes ----------
create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references public.profiles(id) on delete cascade,
  doc_type    text not null,
  file_path   text not null,
  file_name   text not null,
  file_size   bigint,
  file_type   text,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- Fonctions d'accès (qui a le droit de voir quoi)
-- =====================================================================
create or replace function public.is_bureau() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'bureau');
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role <> 'pending');
$$;

-- Équipes visibles : la sienne (athlète), celles des enfants (parent), toutes (bureau)
create or replace function public.my_team_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select id from teams where is_bureau()
  union
  select team_id from profiles where id = auth.uid() and role = 'athlete' and team_id is not null
  union
  select p.team_id from parent_links l join profiles p on p.id = l.athlete_id
   where l.parent_id = auth.uid() and p.team_id is not null;
$$;

-- Peut agir pour cet athlète : lui-même, un de ses parents, ou le bureau
create or replace function public.can_act_for(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a = auth.uid()
      or is_bureau()
      or exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a);
$$;

create or replace function public.can_see_event(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_bureau() or exists(
    select 1 from event_teams where event_id = e and team_id in (select my_team_ids()));
$$;

create or replace function public.trip_event(t uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select event_id from trips where id = t;
$$;

-- Nouveau compte : profil créé automatiquement, en attente de validation.
-- Le tout premier compte créé devient automatiquement membre du bureau.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when exists(select 1 from profiles where role = 'bureau') then 'pending' else 'bureau' end
  );
  insert into profile_private (id, email) values (new.id, new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Empêche un membre de changer lui-même son rôle ou son équipe
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() and auth.uid() is not null then
    new.role := old.role;
    new.team_id := old.team_id;
    new.title := old.title;
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile();

-- =====================================================================
-- Règles d'accès (Row Level Security)
-- =====================================================================
alter table public.teams         enable row level security;
alter table public.profiles      enable row level security;
alter table public.parent_links  enable row level security;
alter table public.profile_private enable row level security;
alter table public.events        enable row level security;
alter table public.event_teams   enable row level security;
alter table public.trips         enable row level security;
alter table public.trip_steps    enable row level security;
alter table public.trip_items    enable row level security;
alter table public.trip_presence enable row level security;
alter table public.trip_packed   enable row level security;
alter table public.messages      enable row level security;
alter table public.documents     enable row level security;

-- Équipes : lisibles par tous les connectés, modifiables par le bureau
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams for select to authenticated using (true);
drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams for all to authenticated using (is_bureau()) with check (is_bureau());

-- Profils : chaque membre voit les noms des membres du club ; un compte en attente ne voit que le sien
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or is_member());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() or is_bureau()) with check (id = auth.uid() or is_bureau());
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated using (is_bureau());

drop policy if exists private_read on public.profile_private;
create policy private_read on public.profile_private for select to authenticated using (id = auth.uid() or is_bureau());

-- Liens parent/enfant
drop policy if exists links_read on public.parent_links;
create policy links_read on public.parent_links for select to authenticated
  using (parent_id = auth.uid() or athlete_id = auth.uid() or is_bureau());
drop policy if exists links_write on public.parent_links;
create policy links_write on public.parent_links for all to authenticated using (is_bureau()) with check (is_bureau());

-- Planning
drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (can_see_event(id));
drop policy if exists events_write on public.events;
create policy events_write on public.events for all to authenticated using (is_bureau()) with check (is_bureau());
drop policy if exists event_teams_read on public.event_teams;
create policy event_teams_read on public.event_teams for select to authenticated using (can_see_event(event_id));
drop policy if exists event_teams_write on public.event_teams;
create policy event_teams_write on public.event_teams for all to authenticated using (is_bureau()) with check (is_bureau());

-- Déplacements
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated using (can_see_event(event_id));
drop policy if exists trips_write on public.trips;
create policy trips_write on public.trips for all to authenticated using (is_bureau()) with check (is_bureau());
drop policy if exists steps_read on public.trip_steps;
create policy steps_read on public.trip_steps for select to authenticated using (can_see_event(trip_event(trip_id)));
drop policy if exists steps_write on public.trip_steps;
create policy steps_write on public.trip_steps for all to authenticated using (is_bureau()) with check (is_bureau());
drop policy if exists items_read on public.trip_items;
create policy items_read on public.trip_items for select to authenticated using (can_see_event(trip_event(trip_id)));
drop policy if exists items_write on public.trip_items;
create policy items_write on public.trip_items for all to authenticated using (is_bureau()) with check (is_bureau());
drop policy if exists presence_all on public.trip_presence;
create policy presence_all on public.trip_presence for all to authenticated
  using (can_act_for(athlete_id)) with check (can_act_for(athlete_id));
drop policy if exists packed_all on public.trip_packed;
create policy packed_all on public.trip_packed for all to authenticated
  using (can_act_for(athlete_id)) with check (can_act_for(athlete_id));

-- Messages : tchat d'équipe visible par les membres de l'équipe (athlètes, parents, bureau)
-- Messages privés : visibles uniquement par les deux personnes ; seul le bureau peut écrire à n'importe qui
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  (team_id is not null and team_id in (select my_team_ids()))
  or auth.uid() = dm_a or auth.uid() = dm_b
);
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and is_member()
  and (not is_announcement or is_bureau())
  and (
    (team_id is not null and team_id in (select my_team_ids()))
    or (team_id is null and auth.uid() in (dm_a, dm_b) and (
          is_bureau()
          or exists(select 1 from profiles where id in (dm_a, dm_b) and id <> auth.uid() and role = 'bureau')))
  )
);
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated using (sender_id = auth.uid() or is_bureau());

-- Documents : visibles par l'athlète, ses parents et le bureau
drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents for select to authenticated using (can_act_for(athlete_id));
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
  with check (can_act_for(athlete_id) and uploaded_by = auth.uid());
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated using (is_bureau() or uploaded_by = auth.uid());

-- =====================================================================
-- Stockage des fichiers (privé)
--   documents/<athlete_id>/<fichier>
--   chat/team/<team_id>/<fichier>   ou   chat/dm/<idA>_<idB>/<fichier>
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('club-files', 'club-files', false, 10485760)
on conflict (id) do nothing;

create or replace function public.can_access_file(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(path, '/');
begin
  if parts[1] = 'documents' then
    return can_act_for(parts[2]::uuid);
  elsif parts[1] = 'chat' and parts[2] = 'team' then
    return parts[3] in (select my_team_ids());
  elsif parts[1] = 'chat' and parts[2] = 'dm' then
    return auth.uid()::text = any(string_to_array(parts[3], '_'));
  end if;
  return false;
exception when others then
  return false;
end $$;

drop policy if exists club_files_read on storage.objects;
create policy club_files_read on storage.objects for select to authenticated
  using (bucket_id = 'club-files' and can_access_file(name));
drop policy if exists club_files_insert on storage.objects;
create policy club_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'club-files' and is_member() and can_access_file(name));
drop policy if exists club_files_delete on storage.objects;
create policy club_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'club-files' and (is_bureau() or owner = auth.uid()));

-- Messages en temps réel
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when others then null; end $$;

-- =====================================================================
-- Données de départ : équipes et entraînements de la saison
-- =====================================================================
insert into public.teams (id, name, color, position) values
  ('lionceaux','Lionceaux','#e8920c',1),
  ('tigrous',  'Tigrous',  '#0891b2',2),
  ('tigroux',  'Tigroux',  '#0e9f6e',3),
  ('servals',  'Servals',  '#5b50e6',4),
  ('cougars',  'Cougars',  '#d81b5a',5),
  ('panthers', 'Panthers', '#64748b',6),
  ('pom',      'Pom',      '#c026d3',7)
on conflict (id) do update set name = excluded.name, color = excluded.color, position = excluded.position;

-- Entraînements hebdomadaires jusqu'au 30 juin 2027 (isodow : 1 = lundi … 6 = samedi)
do $$
declare
  r record;
  d date;
  eid uuid;
begin
  if exists(select 1 from events where type = 'train') then return; end if;
  for r in select * from (values
      ('lionceaux',2,'17:45'::time,'19:00'::time),
      ('tigrous',  6,'10:00','12:00'),
      ('tigroux',  6,'10:00','12:00'),
      ('servals',  2,'17:45','19:15'),
      ('servals',  5,'17:45','19:15'),
      ('cougars',  4,'19:00','21:00'),
      ('panthers', 3,'19:00','21:30'),
      ('panthers', 5,'19:15','21:15'),
      ('pom',      1,'18:00','20:00')
    ) as t(team, dow, s, e)
  loop
    for d in select g::date from generate_series(current_date, date '2027-06-30', interval '1 day') g
             where extract(isodow from g) = r.dow
    loop
      insert into events (type, title, date, start_time, end_time, place)
      values ('train', 'Entraînement', d, r.s, r.e, 'Salle Sainte-Ursule, Pau') returning id into eid;
      insert into event_teams values (eid, r.team);
    end loop;
  end loop;
end $$;

-- =====================================================================
-- Mise à jour n°2 incluse (déplacements sur plusieurs jours)
alter table public.trips add column if not exists depart_date date;
alter table public.trips add column if not exists return_date date;
alter table public.trips add column if not exists lodging text not null default '';
alter table public.trip_steps add column if not exists day date;

-- Trajets : aller, retour ou étape intermédiaire, avec le moyen de transport
create table if not exists public.trip_legs (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  kind       text not null default 'aller' check (kind in ('aller','retour','autre')),
  mode       text not null default 'Bus',
  day        date,
  time       time,
  from_place text not null default '',
  to_place   text not null default '',
  details    text not null default ''
);
alter table public.trip_legs enable row level security;
drop policy if exists legs_read on public.trip_legs;
create policy legs_read on public.trip_legs for select to authenticated using (can_see_event(trip_event(trip_id)));
drop policy if exists legs_write on public.trip_legs;
create policy legs_write on public.trip_legs for all to authenticated using (is_bureau()) with check (is_bureau());

-- Déplacements déjà créés : départ le jour de la compétition par défaut
update public.trips t set depart_date = e.date from public.events e where e.id = t.event_id and t.depart_date is null;
update public.trips t set return_date = e.date from public.events e where e.id = t.event_id and t.return_date is null;
update public.trip_steps s set day = coalesce(t.depart_date, s.day) from public.trips t where t.id = s.trip_id and s.day is null;

-- =====================================================================
-- Mise à jour n°3 incluse (droits, coachs, présences, arrivées des trajets)
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
