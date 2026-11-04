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
create table if not exists public.launcher_commands (
  id uuid primary key default gen_random_uuid(),
  command text not null check (command in ('kill_all_launchers')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','received','completed','failed')),
  created_at timestamptz not null default now()
);
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
-- Enable RLS; the server accesses tables with the service role key, which bypasses RLS.
alter table public.whitelists enable row level security;
alter table public.serverinfo enable row level security;
alter table public.launcher_commands enable row level security;
