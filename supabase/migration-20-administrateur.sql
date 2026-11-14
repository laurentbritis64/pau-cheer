-- =====================================================================
-- Mise à jour 20 : rôle « Administrateur de l'application »
-- Tous les droits du bureau, mais présenté à part (pas membre du bureau).
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

alter table public.profiles add column if not exists app_admin boolean not null default false;

-- Seul le bureau (ou un administrateur) peut changer ce réglage
create or replace function public.protect_app_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_bureau() and auth.uid() is not null then new.app_admin := old.app_admin; end if;
  return new;
end $$;
drop trigger if exists profiles_protect_admin on public.profiles;
create trigger profiles_protect_admin before update on public.profiles
  for each row execute function public.protect_app_admin();
