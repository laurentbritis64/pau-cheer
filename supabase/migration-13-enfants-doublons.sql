-- =====================================================================
-- Mise à jour 13 : retirer un enfant ajouté par erreur,
-- repérer un enfant déjà inscrit (même prénom, nom qui commence pareil,
-- même date de naissance ou même équipe) et demander à y être relié
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Texte simplifié pour comparer les noms : minuscules, sans accents ni tirets
create or replace function public.plain(t text) returns text
language sql immutable as $$
  select regexp_replace(translate(lower(trim(coalesce(t, ''))),
    'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ-''',
    'aaaaaaceeeeiiiinooooouuuuyyoa  '), '\s+', ' ', 'g')
$$;

-- ---------- Enfants qui ressemblent à celui qu'on veut ajouter ----------
create or replace function public.similar_children(p_first text, p_last text, p_birth date, p_team text)
returns table(id uuid, full_name text, team_id text, birth_date date, same_birth boolean, same_team boolean)
language plpgsql stable security definer set search_path = public as $$
declare f text := plain(p_first); l text := plain(p_last);
begin
  if not is_member() or length(f) < 2 then return; end if;
  return query
  with c as (
    select p.*, plain(p.full_name) as n from profiles p
     where p.id <> auth.uid()
       and (p.role = 'athlete' or p.managed or (p.role = 'pending' and p.wish = 'athlete')
            or (p.role in ('bureau', 'coach') and p.team_id is not null))
       and not exists(select 1 from parent_links k where k.parent_id = auth.uid() and k.athlete_id = p.id)
  ), m as (
    select c.*,
      -- le reste du nom une fois le prénom retiré (au début ou à la fin)
      case when c.n like f || ' %' then substr(c.n, length(f) + 2)
           when c.n like '% ' || f then left(c.n, length(c.n) - length(f) - 1)
           when split_part(c.n, ' ', 1) like f || '%' then substr(c.n, length(split_part(c.n, ' ', 1)) + 2)
      end as rest
    from c
  )
  select m.id, m.full_name, m.team_id, m.birth_date,
         coalesce(m.birth_date = p_birth, false), coalesce(m.team_id = p_team, false)
    from m
   where m.rest is not null
     and (l = ''                                              -- nom pas saisi
          or m.rest like l || '%' or l like m.rest || '%'      -- nom saisi en partie
          or left(m.rest, 3) = left(l, 3)                      -- début du nom identique
          or m.birth_date = p_birth)                           -- même date de naissance
   order by (m.birth_date = p_birth) desc nulls last, (m.team_id = p_team) desc nulls last, m.full_name
   limit 6;
end $$;
revoke execute on function public.similar_children(text, text, date, text) from public, anon;
grant execute on function public.similar_children(text, text, date, text) to authenticated;

-- ---------- Demandes pour être relié à un enfant déjà inscrit ----------
create table if not exists public.link_requests (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid not null references public.profiles(id) on delete cascade,
  athlete_id  uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'refused', 'cancelled')),
  created_at  timestamptz not null default now(),
  decided_by  uuid references public.profiles(id) on delete set null
);
create unique index if not exists link_requests_one_pending on public.link_requests(parent_id, athlete_id) where status = 'pending';
alter table public.link_requests enable row level security;
drop policy if exists link_requests_read on public.link_requests;
create policy link_requests_read on public.link_requests for select to authenticated
  using (parent_id = auth.uid() or is_bureau());

-- Le bureau relie tout de suite, un parent envoie une demande au bureau
create or replace function public.request_link(a uuid) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not is_member() then raise exception 'Non autorisé'; end if;
  if a = auth.uid() or not exists(select 1 from profiles where id = a and role <> 'parent') then raise exception 'Enfant introuvable'; end if;
  if exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a) then return 'linked'; end if;
  if is_bureau() then
    insert into parent_links (parent_id, athlete_id) values (auth.uid(), a) on conflict do nothing;
    return 'linked';
  end if;
  insert into link_requests (parent_id, athlete_id) values (auth.uid(), a) on conflict do nothing;
  return 'requested';
end $$;
revoke execute on function public.request_link(uuid) from public, anon;
grant execute on function public.request_link(uuid) to authenticated;

create or replace function public.decide_link_request(r uuid, ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare q link_requests;
begin
  select * into q from link_requests where id = r;
  if q.id is null then raise exception 'Demande introuvable'; end if;
  if q.parent_id = auth.uid() and not ok then  -- le parent annule sa propre demande
    update link_requests set status = 'cancelled' where id = r and status = 'pending';
    return;
  end if;
  if not is_bureau() then raise exception 'Réservé au bureau'; end if;
  if ok then
    insert into parent_links (parent_id, athlete_id) values (q.parent_id, q.athlete_id) on conflict do nothing;
  end if;
  update link_requests set status = case when ok then 'accepted' else 'refused' end, decided_by = auth.uid()
   where id = r and status = 'pending';
end $$;
revoke execute on function public.decide_link_request(uuid, boolean) from public, anon;
grant execute on function public.decide_link_request(uuid, boolean) to authenticated;

-- ---------- Retirer un enfant ajouté par erreur ----------
-- Enfant sans compte et sans autre parent : il est supprimé.
-- Sinon (l'autre parent l'a aussi, ou l'enfant a son propre compte) : on retire seulement le lien.
create or replace function public.remove_child(a uuid) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not is_member() then raise exception 'Non autorisé'; end if;
  if not exists(select 1 from parent_links where parent_id = auth.uid() and athlete_id = a) then
    raise exception 'Cet enfant n''est pas relié à ton compte';
  end if;
  if exists(select 1 from profiles where id = a and managed)
     and not exists(select 1 from parent_links where athlete_id = a and parent_id <> auth.uid())
     and not exists(select 1 from auth.users where id = a) then
    delete from profiles where id = a;
    return 'deleted';
  end if;
  delete from parent_links where parent_id = auth.uid() and athlete_id = a;
  return 'unlinked';
end $$;
revoke execute on function public.remove_child(uuid) from public, anon;
grant execute on function public.remove_child(uuid) to authenticated;
