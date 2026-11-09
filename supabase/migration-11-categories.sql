-- =====================================================================
-- Mise à jour 11 : nouvelles catégories d'événements (camp / stage, événement club)
-- et horaire « à confirmer »
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('train', 'comp', 'camp', 'event'));
alter table public.events add column if not exists no_time boolean not null default false;  -- horaire à confirmer (mis par défaut de 14h00 à 17h00)
