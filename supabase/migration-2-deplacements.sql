-- =====================================================================
-- Mise à jour n°2 : déplacements sur plusieurs jours et trajets (bus, avion…)
-- À coller dans Supabase > SQL Editor > New query > Run (une seule fois)
-- =====================================================================
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
