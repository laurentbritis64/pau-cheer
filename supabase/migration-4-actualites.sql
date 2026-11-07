-- =====================================================================
-- Mise à jour n°4 : actualités du club (page d'accueil)
-- À coller dans Supabase > SQL Editor > New query > Run (une seule fois)
-- =====================================================================
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
