-- =====================================================================
-- Calendrier des Servals 2026-2027
-- À coller dans Supabase > SQL Editor > New query > Run (après la mise à jour 11)
-- Peut être relancé sans créer de doublons.
-- Les absences déjà déclarées sur les entraînements conservés sont gardées.
-- Les entraînements de toutes les équipes pendant les vacances scolaires sont supprimés,
-- sauf ceux des Servals le 16 février et le 13 avril.
-- =====================================================================
do $$
declare
  d date;
  eid uuid;
  tid uuid;
  tue date[] := array['2026-11-10','2026-11-17','2026-11-24','2026-12-01','2026-12-08','2026-12-15',
    '2027-01-05','2027-01-12','2027-01-19','2027-01-26','2027-02-02','2027-02-09','2027-02-16',
    '2027-03-02','2027-03-09','2027-03-16','2027-03-23','2027-03-30','2027-04-06','2027-04-13','2027-04-27',
    '2027-05-04','2027-05-11','2027-05-18','2027-05-25','2027-06-01','2027-06-08','2027-06-15','2027-06-22','2027-06-29']::date[];
  fri date[] := array['2026-11-13','2026-11-27','2026-12-04','2026-12-11','2026-12-18',
    '2027-01-08','2027-01-15','2027-01-22','2027-01-29','2027-02-05','2027-02-12',
    '2027-03-05','2027-03-12','2027-03-19','2027-03-26','2027-04-02','2027-04-09','2027-04-30',
    '2027-05-14','2027-05-21','2027-05-28','2027-06-04','2027-06-11','2027-06-18','2027-06-25']::date[];
  r record;
begin
  -- 1. Entraînements des Servals : on retire ceux qui ne sont plus au calendrier
  delete from events e
   where e.type = 'train' and e.date >= current_date
     and (select array_agg(team_id) from event_teams where event_id = e.id) = array['servals']
     and not (e.date = any(tue) or e.date = any(fri));

  -- 2. On met les bons horaires et on ajoute ceux qui manquent
  for d in select unnest(tue || fri) loop
    continue when d < current_date;
    select e.id into eid from events e
     where e.type = 'train' and e.date = d
       and (select array_agg(team_id) from event_teams where event_id = e.id) = array['servals']
     limit 1;
    if eid is null then
      insert into events (type, title, date, start_time, end_time, place)
      values ('train', 'Entraînement', d, '17:45', case when d = any(tue) then '20:00'::time else '19:30'::time end, 'Salle Sainte-Ursule, Pau')
      returning id into eid;
      insert into event_teams values (eid, 'servals');
    else
      update events set start_time = '17:45', end_time = case when d = any(tue) then '20:00'::time else '19:30'::time end
       where id = eid;
    end if;
  end loop;

  -- 3. Camps, événements du club et compétitions des Servals
  for r in select * from (values
      ('camp',  'Camp avec Karim',              date '2026-11-20', time '18:00', time '20:30', false, 'Salle Sainte-Ursule, Pau'),
      ('camp',  'Camp tumbling avec Lauriane',  date '2026-12-12', time '14:00', time '17:00', true,  'Salle Sainte-Ursule, Pau'),
      ('event', 'Gala des vœux',                date '2027-01-09', time '14:00', time '17:00', true,  ''),
      ('event', 'Showcase',                     date '2027-03-13', time '14:00', time '17:00', true,  ''),
      ('event', 'Entraînement commun',          date '2027-03-20', time '14:00', time '17:00', true,  ''),
      ('comp',  'Qualifications FFFA',          date '2027-03-21', time '14:00', time '17:00', true,  'Pau'),
      ('comp',  'Compétition TSN',              date '2027-05-15', time '14:00', time '17:00', true,  'Paris'),
      ('comp',  'Compétition OCC',              date '2027-06-05', time '14:00', time '17:00', true,  'Orléans')
    ) as t(type, title, date, s, e, no_time, place)
  loop
    continue when r.date < current_date;
    if not exists(select 1 from events where title = r.title and date = r.date) then
      insert into events (type, title, date, start_time, end_time, place, no_time)
      values (r.type, r.title, r.date, r.s, r.e, r.place, r.no_time) returning id into eid;
      insert into event_teams values (eid, 'servals');
      -- Déplacement à organiser pour les compétitions à l'extérieur
      if r.type = 'comp' and r.place <> 'Pau' then
        insert into trips (event_id, transport, depart_place, depart_date, return_date, contact)
        values (eid, 'Bus', 'Salle Sainte-Ursule, Pau', r.date - 1, r.date + 1, '') returning id into tid;
        insert into trip_items (trip_id, label, position) values
          (tid, 'Tenue de compétition complète', 0), (tid, 'Nœud et chaussures de cheer', 1),
          (tid, 'Pique-nique et bouteille d''eau', 2), (tid, 'Licence FFFA', 3);
      end if;
    end if;
  end loop;

  -- 4. Pas d'entraînement pendant les vacances scolaires (toutes les équipes)
  delete from events t
   where t.type = 'train' and t.date >= current_date
     and (t.date between '2026-12-19' and '2027-01-03'
       or t.date between '2027-02-13' and '2027-02-28'
       or t.date between '2027-04-10' and '2027-04-25')
     -- exceptions : les Servals s'entraînent quand même le 16 février et le 13 avril
     and not (t.date in ('2027-02-16', '2027-04-13')
              and (select array_agg(team_id) from event_teams where event_id = t.id) = array['servals']);
end $$;
