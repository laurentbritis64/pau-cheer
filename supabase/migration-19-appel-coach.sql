-- =====================================================================
-- Mise à jour 19 : le coach peut signaler les absents de ses équipes
-- (quand l'athlète ou son parent ne l'a pas fait)
-- À coller dans Supabase > SQL Editor > New query > Run
-- Peut être relancée sans risque.
-- =====================================================================

drop policy if exists attendance_write on public.attendance;
create policy attendance_write on public.attendance for all to authenticated
  using (can_act_for(athlete_id) or is_coach_of(athlete_id))
  with check (can_act_for(athlete_id) or is_coach_of(athlete_id));
