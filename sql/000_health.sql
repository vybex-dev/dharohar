-- Extensions (no-op if already enabled)
create extension if not exists postgis with schema extensions;
create extension if not exists vector  with schema extensions;

-- Health table
create table if not exists public.health_check (
  id         int primary key,
  note       text not null,
  created_at timestamptz not null default now()
);

insert into public.health_check (id, note)
values (1, 'Dharohar is alive')
on conflict (id) do nothing;

-- RLS on, no policies: anon/authenticated see nothing; service_role bypasses RLS
alter table public.health_check enable row level security;

-- Explicit privileges for the server-side role
grant usage on schema public to service_role;
grant select on public.health_check to service_role;

-- Future-proofing: anything created later in public by this role (postgres,
-- i.e. via the SQL Editor) is automatically usable by service_role.
-- anon/authenticated are deliberately NOT included; grant those per table later.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

-- Reports whether postgis and vector are installed
create or replace function public.health_extensions()
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(extname order by extname), '{}')
  from pg_extension
  where extname in ('postgis', 'vector');
$$;

revoke all on function public.health_extensions() from public, anon, authenticated;
grant execute on function public.health_extensions() to service_role;