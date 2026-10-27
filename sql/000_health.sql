-- Extensions (no-op if already enabled via the dashboard)
create extension if not exists postgis with schema extensions;
create extension if not exists vector  with schema extensions;

-- Tiny table for the health check
create table if not exists public.health_check (
  id         int primary key,
  note       text not null,
  created_at timestamptz not null default now()
);

insert into public.health_check (id, note)
values (1, 'Dharohar is alive')
on conflict (id) do nothing;

-- Lock it down: RLS on, no policies => only the service role can read it
alter table public.health_check enable row level security;

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