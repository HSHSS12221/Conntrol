-- Run this once in Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;
create table if not exists public.whitelists (
  id uuid primary key default gen_random_uuid(),
  steam_id text not null unique,
  discord_id text,
  player_name text,
  status text not null default 'pending' check (status in ('approved','pending','banned')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Keep the full player-model payload alongside each whitelist entry.
alter table public.whitelists add column if not exists auth jsonb not null default '[]'::jsonb;
alter table public.whitelists add column if not exists session_token text;
alter table public.whitelists add column if not exists profile jsonb not null default '{"display":"Profile_Default","displayName":"","lastNameUpdate":null}'::jsonb;
alter table public.whitelists add column if not exists coin numeric not null default 0;
alter table public.whitelists add column if not exists amethyst numeric not null default 0;
alter table public.whitelists add column if not exists amulet numeric not null default 0;
alter table public.whitelists add column if not exists character_slot jsonb;
alter table public.whitelists add column if not exists role text not null default 'survivor';
alter table public.whitelists add column if not exists ban_status jsonb;
alter table public.whitelists add column if not exists player_record jsonb;
alter table public.whitelists add column if not exists sticker_slot jsonb;
alter table public.whitelists add column if not exists inventory jsonb;
alter table public.whitelists add column if not exists immortal_data jsonb not null default '[]'::jsonb;
alter table public.whitelists add column if not exists game_data jsonb not null default '{}'::jsonb;
alter table public.whitelists add column if not exists is_online boolean not null default false;
alter table public.whitelists add column if not exists last_online timestamptz;
create table if not exists public.serverinfo (
  id uuid primary key default gen_random_uuid(),
  room_name text not null,
  host_ip text not null,
  port integer not null default 7777,
  max_players integer not null default 8,
  is_online boolean not null default true,
  server_version text,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Discord verification panel and six editable guide cards (3 Thai + 3 English).
create table if not exists public.discord_settings (
  id smallint primary key default 1 check (id = 1),
  verify_channel_id text,
  verify_message_id text,
  updated_at timestamptz not null default now()
);
-- Short-lived Discord OAuth handoff sessions used by Launcher Login.
create table if not exists public.launcher_login_sessions (
  id text primary key,
  status text not null default 'pending' check (status in ('pending','approved','not_whitelisted')),
  discord_id text,
  steam_id text,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.discord_verification_guides (
  language text not null check (language in ('th','en')),
  step smallint not null check (step between 1 and 3),
  title text not null,
  body text not null default '',
  image_url text,
  updated_at timestamptz not null default now(),
  primary key (language, step)
);
insert into public.discord_verification_guides(language, step, title, body)
values
  ('th',1,'วิธี Verify • ขั้นที่ 1',''), ('th',2,'วิธี Verify • ขั้นที่ 2',''), ('th',3,'วิธี Verify • ขั้นที่ 3',''),
  ('en',1,'How to Verify • Step 1',''), ('en',2,'How to Verify • Step 2',''), ('en',3,'How to Verify • Step 3','')
on conflict (language, step) do nothing;
create table if not exists public.launcher_commands (
  id uuid primary key default gen_random_uuid(),
  command text not null check (command in ('kill_all_launchers','refresh_whitelist')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','received','completed','failed')),
  created_at timestamptz not null default now()
);
-- Migrate older launcher_commands tables created before command status/age tracking existed.
alter table public.launcher_commands
  add column if not exists status text not null default 'pending';
alter table public.launcher_commands
  add column if not exists created_at timestamptz not null default now();
alter table public.launcher_commands drop constraint if exists launcher_commands_command_check;
alter table public.launcher_commands add constraint launcher_commands_command_check
  check (command in ('kill_all_launchers','refresh_whitelist'));
create table if not exists public.launcher_command_deliveries (
  command_id uuid not null references public.launcher_commands(id) on delete cascade,
  client_id text not null,
  delivered_at timestamptz not null default now(),
  primary key(command_id, client_id)
);
create or replace function public.get_pending_launcher_commands(p_client_id text)
returns setof public.launcher_commands
language sql
security invoker
as $$
  select c.*
  from public.launcher_commands c
  where c.status = 'pending'
    and c.created_at >= now() - interval '2 minutes'
    and not exists (
      select 1 from public.launcher_command_deliveries d
      where d.command_id = c.id and d.client_id = p_client_id
    )
  order by c.created_at asc
  limit 20;
$$;
revoke all on function public.get_pending_launcher_commands(text) from public, anon, authenticated;
grant execute on function public.get_pending_launcher_commands(text) to service_role;
-- Logical databases/collections for the Mongo-like Cluster Explorer (JSONB documents).
create table if not exists public.admin_databases (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.admin_collections (
  id uuid primary key default gen_random_uuid(),
  database_id uuid not null references public.admin_databases(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique(database_id, name)
);
create table if not exists public.admin_documents (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.admin_collections(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Repository game JSON definitions stored in Supabase and served to the game/launcher.
create table if not exists public.game_static_data (
  file_path text primary key check (file_path like 'static/%.json'),
  data jsonb not null,
  sha256 text not null,
  updated_at timestamptz not null default now()
);
alter table public.game_static_data enable row level security;
revoke all on public.game_static_data from anon, authenticated;
grant all on public.game_static_data to service_role;
create or replace function public.replace_admin_documents(p_collection_id uuid, p_documents jsonb)
returns setof public.admin_documents
language plpgsql
as $$
begin
  if p_documents is null or jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) > 2000 then
    raise exception 'Expected a JSON array with at most 2000 documents';
  end if;
  if exists (select 1 from jsonb_array_elements(p_documents) as item(value) where jsonb_typeof(item.value) <> 'object') then
    raise exception 'Each document must be a JSON object';
  end if;
  delete from public.admin_documents where collection_id = p_collection_id;
  return query
    insert into public.admin_documents(collection_id, data)
    select p_collection_id, item.value from jsonb_array_elements(p_documents) as item(value)
    returning *;
end;
$$;
revoke all on function public.replace_admin_documents(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_admin_documents(uuid, jsonb) to service_role;
alter table public.admin_databases enable row level security;
alter table public.admin_collections enable row level security;
alter table public.admin_documents enable row level security;
-- Seed the project database namespace and the existing player/server collections.
insert into public.admin_databases(name) values ('HSHO-PrivateServer') on conflict (name) do nothing;
insert into public.admin_collections(database_id, name)
select d.id, c.name from public.admin_databases d
cross join (values ('players'), ('whitelists'), ('serverinfo')) as c(name)
where d.name = 'HSHO-PrivateServer'
on conflict (database_id, name) do nothing;
-- Copy any existing structured server rows into the flexible JSONB collection once.
insert into public.admin_documents(collection_id, data)
select c.id, jsonb_build_object(
  'room_name', s.room_name, 'host_ip', s.host_ip, 'port', s.port,
  'max_players', s.max_players, 'is_online', s.is_online,
  'server_version', s.server_version, 'extra', s.extra
)
from public.serverinfo s
join public.admin_databases d on d.name = 'HSHO-PrivateServer'
join public.admin_collections c on c.database_id = d.id and c.name = 'serverinfo'
where not exists (
  select 1 from public.admin_documents x
  where x.collection_id = c.id and x.data = jsonb_build_object(
    'room_name', s.room_name, 'host_ip', s.host_ip, 'port', s.port,
    'max_players', s.max_players, 'is_online', s.is_online,
    'server_version', s.server_version, 'extra', s.extra
  )
);
-- Enable RLS; the server accesses tables with the service role key, which bypasses RLS.
alter table public.whitelists enable row level security;
alter table public.serverinfo enable row level security;
alter table public.launcher_commands enable row level security;
alter table public.launcher_command_deliveries enable row level security;
alter table public.discord_settings enable row level security;
alter table public.launcher_login_sessions enable row level security;
alter table public.discord_verification_guides enable row level security;
revoke all on public.discord_settings, public.discord_verification_guides from anon, authenticated;
revoke all on public.launcher_login_sessions from anon, authenticated;
grant all on public.launcher_login_sessions to service_role;
grant all on public.discord_settings, public.discord_verification_guides to service_role;
revoke all on public.launcher_command_deliveries from anon, authenticated;
grant all on public.launcher_command_deliveries to service_role;
