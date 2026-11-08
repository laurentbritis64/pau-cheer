-- =====================================================================
-- Mise à jour 8 : sexe, téléphones, responsable légal, contact d'urgence
-- À coller dans Supabase > SQL Editor > New query > Run
-- =====================================================================

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
