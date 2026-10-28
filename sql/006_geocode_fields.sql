-- sql/006_geocode_fields.sql
-- Run in the Supabase SQL Editor. Idempotent.
-- Supports lib/stages/geocode.ts:
--   - a final location on BOTH sites and assets
--   - a flag the review screen can use when no location could be determined
--   - lat/lon on geocode_cache so a cached Nominatim result can be read back
--     as plain numbers (PostgREST does not expose `geography` as numbers)

alter table public.sites
  add column if not exists needs_manual_location boolean not null default false;

alter table public.assets
  add column if not exists location geography(point, 4326),
  add column if not exists location_source text
    check (location_source in ('exif','geocoded','manual','seed')),
  add column if not exists location_confidence real
    check (location_confidence between 0 and 1),
  add column if not exists needs_manual_location boolean not null default false;

create index if not exists assets_location_gix on public.assets using gist (location);

alter table public.geocode_cache
  add column if not exists lat double precision,
  add column if not exists lon double precision;

notify pgrst, 'reload schema';