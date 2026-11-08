-- =====================================================================
-- Mise à jour n°5 : messages privés avec les coachs
--   * athlètes et parents peuvent écrire au bureau et aux coachs de leurs équipes
--   * un coach peut écrire aux athlètes et parents de ses équipes, et au bureau
--   * le bureau peut écrire à tout le monde
-- À coller dans Supabase > SQL Editor > New query > Run (une seule fois)
-- =====================================================================
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
