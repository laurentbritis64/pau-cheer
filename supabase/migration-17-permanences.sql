-- =====================================================================
-- Mise à jour 17 : permanences (ex. papiers cadeaux)
-- Le bureau crée un agenda entre deux dates, découpé en créneaux ;
-- chacun réserve un créneau pour indiquer sa présence.
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

create table if not exists public.shift_boards (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  place        text not null default '',
  description  text not null default '',
  start_date   date not null,
  end_date     date not null,
  day_start    time not null default '08:30',
  day_end      time not null default '20:30',
  slot_minutes int  not null default 120 check (slot_minutes between 15 and 720),
  capacity     int  not null default 3 check (capacity between 1 and 50),
  teams        text[],                      -- vide : tout le club
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 92),
  check (day_end > day_start)
);

create table if not exists public.shift_signups (
  board_id   uuid not null references public.shift_boards(id) on delete cascade,
  day        date not null,
  start_time time not null,
  person_id  uuid not null references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (board_id, day, start_time, person_id)
);

alter table public.shift_boards  enable row level security;
alter table public.shift_signups enable row level security;

-- Tous les membres validés voient les permanences et qui est inscrit
drop policy if exists shift_boards_read on public.shift_boards;
create policy shift_boards_read on public.shift_boards for select to authenticated using (is_member());
drop policy if exists shift_boards_write on public.shift_boards;
create policy shift_boards_write on public.shift_boards for all to authenticated using (is_planner()) with check (is_planner());

drop policy if exists shift_signups_read on public.shift_signups;
create policy shift_signups_read on public.shift_signups for select to authenticated using (is_member());
-- On s'inscrit soi-même (ou un de ses enfants) ; le bureau peut inscrire ou retirer n'importe qui
drop policy if exists shift_signups_insert on public.shift_signups;
create policy shift_signups_insert on public.shift_signups for insert to authenticated
  with check (is_member() and (can_act_for(person_id) or is_planner()));
drop policy if exists shift_signups_delete on public.shift_signups;
create policy shift_signups_delete on public.shift_signups for delete to authenticated
  using (can_act_for(person_id) or is_planner() or created_by = auth.uid());

-- Contrôles : le créneau existe et n'est pas complet
create or replace function public.check_shift_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare b shift_boards; n int;
begin
  select * into b from shift_boards where id = new.board_id;
  if new.day < b.start_date or new.day > b.end_date
     or new.start_time < b.day_start or new.start_time >= b.day_end
     or (extract(epoch from new.start_time - b.day_start)::int / 60) % b.slot_minutes <> 0 then
    raise exception 'Ce créneau n''existe pas';
  end if;
  perform pg_advisory_xact_lock(hashtext(new.board_id::text || new.day::text || new.start_time::text));
  select count(*) into n from shift_signups where board_id = new.board_id and day = new.day and start_time = new.start_time;
  if n >= b.capacity then raise exception 'Ce créneau est complet'; end if;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists shift_signup_check on public.shift_signups;
create trigger shift_signup_check before insert on public.shift_signups
  for each row execute function public.check_shift_signup();
