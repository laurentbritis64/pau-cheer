-- =====================================================================
-- Mise à jour 18 : notifications sur le téléphone
-- (nouveau message de tchat ; pour le bureau : compte à valider, parent à relier,
--  changement d'équipe ; pour le coach : changement d'équipe vers son équipe)
-- À coller dans Supabase > SQL Editor > New query > Run
-- Puis créer la fonction « notify » (voir le guide). Peut être relancée sans risque.
-- =====================================================================

create extension if not exists pg_net;

-- Réglages privés : aucune règle d'accès, donc illisibles depuis l'application
create table if not exists public.notify_config (
  id            int primary key default 1 check (id = 1),
  function_url  text not null,
  secret        text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  vapid_public  text,
  vapid_private text
);
alter table public.notify_config enable row level security;
insert into public.notify_config (id, function_url)
values (1, 'https://mupoddfgoivkeqtmlnnh.supabase.co/functions/v1/notify')
on conflict (id) do nothing;

-- Téléphones abonnés aux notifications (un par appareil)
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Envoi : la base appelle la fonction « notify » (sans jamais bloquer l'action en cours)
create or replace function public.push_send(users uuid[], title text, body text, url text, tag text)
returns void language plpgsql security definer set search_path = public as $$
declare c notify_config;
begin
  users := array(select distinct u from unnest(users) u where u is not null and u <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid));
  if coalesce(array_length(users, 1), 0) = 0 then return; end if;
  if not exists(select 1 from push_subscriptions where user_id = any(users)) then return; end if;
  select * into c from notify_config where id = 1;
  perform net.http_post(
    url := c.function_url,
    body := jsonb_build_object('secret', c.secret, 'users', to_jsonb(users), 'title', title,
                               'body', left(coalesce(body, ''), 180), 'url', url, 'tag', tag),
    headers := jsonb_build_object('Content-Type', 'application/json'));
exception when others then
  null;  -- une notification ratée ne doit jamais empêcher d'envoyer un message
end $$;
revoke execute on function public.push_send(uuid[], text, text, text, text) from public, anon, authenticated;

-- Membres d'une équipe : athlètes, parents, coachs et bureau
create or replace function public.team_people(t text) returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from profiles where team_id = t and role in ('athlete', 'bureau', 'coach')
  union select l.parent_id from parent_links l join profiles a on a.id = l.athlete_id join profiles p on p.id = l.parent_id
         where a.team_id = t and p.role <> 'pending'
  union select coach_id from coach_teams where team_id = t
  union select id from profiles where role = 'bureau';
$$;

-- Nouveau message
create or replace function public.notify_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce((select split_part(full_name, ' ', 1) from profiles where id = new.sender_id), '');
        txt text := coalesce(nullif(new.body, ''), case when new.file_name is not null then '📎 ' || new.file_name else '' end);
        tm text;
begin
  if new.team_id is not null then
    select name into tm from teams where id = new.team_id;
    perform push_send(array(select team_people(new.team_id)),
      case when new.is_announcement then '📣 Annonce du bureau' else 'Équipe ' || coalesce(tm, new.team_id) end,
      who || ' : ' || txt, './#chat=team:' || new.team_id, 'team:' || new.team_id);
  else
    perform push_send(array[case when new.sender_id = new.dm_a then new.dm_b else new.dm_a end],
      (select full_name from profiles where id = new.sender_id), txt, './#chat=dm:' || new.sender_id, 'dm:' || new.sender_id);
  end if;
  return new;
end $$;
drop trigger if exists messages_notify on public.messages;
create trigger messages_notify after insert on public.messages for each row execute function public.notify_message();

-- Nouvelle inscription à valider (pas les enfants ajoutés en même temps que leur parent)
create or replace function public.notify_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'pending' and not new.managed then
    perform push_send(array(select id from profiles where role = 'bureau'), 'Nouvelle inscription à valider',
      coalesce(nullif(new.full_name, ''), 'Quelqu''un') || case new.wish when 'parent' then ' (parent)' when 'athlete' then ' (athlète)' else '' end,
      './#bureau', 'signup');
  elsif new.role = 'pending' and new.managed and auth.uid() is not null then
    -- enfant ajouté plus tard depuis « Mon compte »
    perform push_send(array(select id from profiles where role = 'bureau'), 'Enfant à valider',
      new.full_name, './#bureau', 'signup');
  end if;
  return new;
end $$;
drop trigger if exists profiles_notify on public.profiles;
create trigger profiles_notify after insert on public.profiles for each row execute function public.notify_signup();

-- Demande de changement d'équipe : coachs de la nouvelle équipe et bureau
create or replace function public.notify_team_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    perform push_send(array(select coach_id from coach_teams where team_id = new.to_team
                            union select id from profiles where role = 'bureau'),
      'Changement d''équipe à valider',
      (select full_name from profiles where id = new.athlete_id) || ' → ' || coalesce((select name from teams where id = new.to_team), new.to_team),
      './#home', 'teamreq');
  end if;
  return new;
end $$;
drop trigger if exists team_requests_notify on public.team_requests;
create trigger team_requests_notify after insert on public.team_requests for each row execute function public.notify_team_request();

-- Parent qui demande à être relié à un enfant : bureau
create or replace function public.notify_link_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    perform push_send(array(select id from profiles where role = 'bureau'), 'Parent à relier',
      (select full_name from profiles where id = new.parent_id) || ' dit être le parent de ' || (select full_name from profiles where id = new.athlete_id),
      './#home', 'linkreq');
  end if;
  return new;
end $$;
drop trigger if exists link_requests_notify on public.link_requests;
create trigger link_requests_notify after insert on public.link_requests for each row execute function public.notify_link_request();
