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
      ('tigrous',  6,'10:00'::time,'12:00'::time),
      ('tigroux',  3,'17:30','19:30'),
      ('servals',  2,'17:45','20:00'),
      ('servals',  5,'17:45','19:30'),
      ('cougars',  4,'19:00','21:00')
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

-- =====================================================================
-- Mise à jour n°4 incluse (actualités)
create table if not exists public.news (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null default '',
  image_path text,
  pinned     boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.news enable row level security;
drop policy if exists news_read on public.news;
create policy news_read on public.news for select to authenticated using (is_member());
drop policy if exists news_write on public.news;
create policy news_write on public.news for all to authenticated using (is_bureau()) with check (is_bureau());

-- Photos des actualités : news/<fichier>, visibles par tous les membres
create or replace function public.can_access_file(path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(path, '/');
begin
  if parts[1] = 'news' then
    return is_member();
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

-- Seul le bureau publie des photos d'actualité
drop policy if exists club_files_insert on storage.objects;
create policy club_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'club-files' and is_member() and can_access_file(name)
              and (split_part(name, '/', 1) <> 'news' or is_bureau()));

-- =====================================================================
-- Mise à jour n°5 incluse (messages privés avec les coachs)
create or replace function public.can_dm_with(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_bureau()
  or exists(select 1 from profiles where id = o and role = 'bureau')
  -- o est coach d'une de mes équipes (la mienne ou celles de mes enfants)
  or exists(select 1 from coach_teams ct join profiles c on c.id = ct.coach_id and c.role = 'coach'
             where ct.coach_id = o and ct.team_id in (select my_team_ids()))
  -- je suis coach et o est athlète ou parent d'une de mes équipes
  or exists(select 1 from coach_teams ct join profiles m on m.id = ct.coach_id and m.role = 'coach'
             where ct.coach_id = auth.uid() and (
               exists(select 1 from profiles a where a.id = o and a.role = 'athlete' and a.team_id = ct.team_id)
               or exists(select 1 from parent_links l join profiles a on a.id = l.athlete_id
                          where l.parent_id = o and a.team_id = ct.team_id)));
$$;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and is_member()
  and (not is_announcement or is_bureau())
  and (
    (team_id is not null and team_id in (select my_team_ids()))
    or (team_id is null and auth.uid() in (dm_a, dm_b)
        and can_dm_with(case when dm_a = auth.uid() then dm_b else dm_a end))
  )
);

-- =====================================================================
-- (Mise à jour 6, incluse ici pour une installation neuve)

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

-- =====================================================================
-- (Mise à jour 8, incluse ici pour une installation neuve)

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

-- =====================================================================
-- (Mise à jour 9, incluse ici pour une installation neuve)

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


-- =====================================================================
-- (Mise à jour 10, incluse ici pour une installation neuve)
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
