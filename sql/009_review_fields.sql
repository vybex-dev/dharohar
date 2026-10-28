-- sql/009_review_fields.sql
-- Run in the Supabase SQL Editor. Idempotent.
-- Supports app/review/[jobId]: records that a human checked / corrected a site.

alter table public.sites
  add column if not exists human_corrected boolean not null default false;
alter table public.sites
  add column if not exists human_corrected_at timestamptz;

-- Make the flag available to /api/sites and the public site page later by
-- appending it to the view (create-or-replace only allows NEW columns at the END).
create or replace view public.sites_geo with (security_invoker = true) as
select
  id, slug, name_en, name_local, category, state, district, address_text,
  summary_en, period, tags, location_source, location_confidence,
  origin, status,
  st_y(location::geometry) as lat,
  st_x(location::geometry) as lng,
  created_at, updated_at,
  region, crafts,
  human_corrected
from public.sites;

notify pgrst, 'reload schema';
