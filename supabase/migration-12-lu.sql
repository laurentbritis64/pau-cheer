-- =====================================================================
-- Mise à jour 12 : savoir si un message a été lu (« Vu », « Lu par… »)
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Dernière lecture de chaque personne dans chaque conversation
-- conv : 'team:<équipe>' ou 'dm:<id1>_<id2>' (les deux id dans l'ordre)
create table if not exists public.chat_reads (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  conv     text not null,
  read_at  timestamptz not null default now(),
  primary key (user_id, conv)
);
alter table public.chat_reads enable row level security;

-- Peut voir cette conversation
create or replace function public.can_see_conv(c text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if c like 'team:%' then
    return is_member() and substr(c, 6) in (select my_team_ids());
  elsif c like 'dm:%' then
    return is_member() and auth.uid()::text = any(string_to_array(substr(c, 4), '_'));
  end if;
  return false;
exception when others then
  return false;
end $$;

drop policy if exists chat_reads_read on public.chat_reads;
create policy chat_reads_read on public.chat_reads for select to authenticated using (can_see_conv(conv));

-- Chacun enregistre seulement sa propre lecture
create or replace function public.mark_read(c text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_see_conv(c) then return; end if;
  insert into chat_reads (user_id, conv, read_at) values (auth.uid(), c, now())
  on conflict (user_id, conv) do update set read_at = greatest(chat_reads.read_at, excluded.read_at);
end $$;
revoke execute on function public.mark_read(text) from public, anon;
grant execute on function public.mark_read(text) to authenticated;

-- Mise à jour en direct
do $$ begin
  alter publication supabase_realtime add table public.chat_reads;
exception when others then null;
end $$;
