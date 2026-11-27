-- =====================================================================
-- Mise à jour 24 : listes « À emporter »
--   * La liste officielle du club peut être rangée en deux sections :
--     « En cabine » (dans l'avion) et « En soute ».
--   * Chaque athlète a en plus SA liste de voyage perso, à cocher.
--     Seuls l'athlète et ses parents la voient (ni le bureau, ni les coachs).
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

-- ---------- Liste officielle : section cabine / soute ----------
alter table public.trip_items add column if not exists zone text;
alter table public.trip_items drop constraint if exists trip_items_zone;
alter table public.trip_items add constraint trip_items_zone check (zone is null or zone in ('cabine', 'soute'));

-- ---------- Liste de voyage perso ----------
create table if not exists public.trip_personal_items (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  label      text not null check (length(label) between 1 and 200),
  done       boolean not null default false,
  position   int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists trip_personal_items_idx on public.trip_personal_items(athlete_id, trip_id);
alter table public.trip_personal_items enable row level security;

-- L'athlète lui-même, ou un parent validé relié à l'enfant (pas le bureau : la liste est privée)
create or replace function public.can_see_personal_list(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a = auth.uid()
      or (is_member() and exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a));
$$;

drop policy if exists personal_items_all on public.trip_personal_items;
create policy personal_items_all on public.trip_personal_items for all to authenticated
  using (can_see_personal_list(athlete_id))
  with check (can_see_personal_list(athlete_id) and can_see_event(trip_event(trip_id)));
