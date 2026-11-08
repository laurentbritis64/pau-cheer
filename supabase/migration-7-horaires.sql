-- =====================================================================
-- Mise à jour 7 : nouveaux horaires d'entraînement (à partir d'aujourd'hui)
-- À coller dans Supabase > SQL Editor > New query > Run
-- Ne touche que les entraînements à venir d'une seule équipe.
-- =====================================================================
drop table if exists _solo;
create temporary table _solo as
  select e.id, min(et.team_id) as team, extract(isodow from e.date)::int as dow
    from events e join event_teams et on et.event_id = e.id
   where e.type = 'train' and e.date >= current_date
   group by e.id having count(*) = 1;

-- Cougars : jeudi 19h00 à 21h00
update events set start_time = '19:00', end_time = '21:00'
 where id in (select id from _solo where team = 'cougars' and dow = 4);
-- Tigrous : samedi 10h00 à 12h00
update events set start_time = '10:00', end_time = '12:00'
 where id in (select id from _solo where team = 'tigrous' and dow = 6);
-- Servals : mardi 17h45 à 20h00, vendredi 17h45 à 19h30
update events set start_time = '17:45', end_time = '20:00'
 where id in (select id from _solo where team = 'servals' and dow = 2);
update events set start_time = '17:45', end_time = '19:30'
 where id in (select id from _solo where team = 'servals' and dow = 5);

-- Tigroux : passent du samedi au mercredi 17h30 à 19h30
delete from events where id in (select id from _solo where team = 'tigroux' and dow = 6);
do $$
declare d date; eid uuid;
begin
  for d in select g::date from generate_series(current_date, date '2027-06-30', interval '1 day') g
           where extract(isodow from g) = 3
  loop
    if not exists(select 1 from _solo where team = 'tigroux' and dow = 3
                    and id in (select id from events where date = d)) then
      insert into events (type, title, date, start_time, end_time, place)
      values ('train', 'Entraînement', d, '17:30', '19:30', 'Salle Sainte-Ursule, Pau') returning id into eid;
      insert into event_teams values (eid, 'tigroux');
    end if;
  end loop;
end $$;
update events set start_time = '17:30', end_time = '19:30'
 where id in (select id from _solo where team = 'tigroux' and dow = 3);

-- Lionceaux, Panthers et Pom : plus d'entraînement prévu (les compétitions restent)
delete from events where id in (select id from _solo where team in ('lionceaux', 'panthers', 'pom'));
drop table if exists _solo;
