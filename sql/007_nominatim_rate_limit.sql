-- sql/007_nominatim_rate_limit.sql
-- Run in the Supabase SQL Editor. Idempotent.
-- Serializes Nominatim calls to >= p_min_gap_ms apart across ALL concurrent
-- /api/jobs/[id]/advance invocations. Different Vercel function instances
-- share no memory, so an in-process limiter alone cannot enforce 1 req/s;
-- this uses a row lock as a cross-instance mutex instead.
-- lib/stages/geocode.ts calls reserve_nominatim_slot() before every Nominatim
-- request and sleeps until the timestamp it returns.

create table if not exists public.nominatim_rate_limit (
  id              boolean primary key default true,
  last_request_at timestamptz,
  constraint nominatim_rate_limit_singleton check (id)
);

insert into public.nominatim_rate_limit (id, last_request_at)
values (true, null)
on conflict (id) do nothing;

create or replace function public.reserve_nominatim_slot(p_min_gap_ms int default 1100)
returns timestamptz
language plpgsql
set search_path = public
as $$
declare
  v_last timestamptz;
  v_next timestamptz;
begin
  select last_request_at into v_last
  from public.nominatim_rate_limit
  where id = true
  for update;

  v_next := greatest(
    now(),
    coalesce(v_last, 'epoch'::timestamptz) + make_interval(secs => p_min_gap_ms / 1000.0)
  );

  update public.nominatim_rate_limit
     set last_request_at = v_next
   where id = true;

  return v_next;
end;
$$;

revoke all on function public.reserve_nominatim_slot(int) from public, anon, authenticated;
grant execute on function public.reserve_nominatim_slot(int) to service_role;

alter table public.nominatim_rate_limit enable row level security; -- no policies = private
revoke all on public.nominatim_rate_limit from anon, authenticated;
grant all on public.nominatim_rate_limit to service_role;

notify pgrst, 'reload schema';