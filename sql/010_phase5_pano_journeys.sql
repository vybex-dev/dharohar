-- =====================================================================
-- 010_phase5_pano_journeys.sql
-- Dharohar Phase 5:
-- 1. Support 'pano' kind for 360-degree equirectangular panoramas
-- 2. Journeys layer: migration for existing table, linestring geography,
--    spatial index, GeoJSON view, and seed routes
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Allow 'pano' in public.assets kind check
-- ---------------------------------------------------------------------
alter table public.assets drop constraint if exists assets_kind_check;
alter table public.assets add constraint assets_kind_check
  check (kind in ('photo', 'scan', 'pano'));

-- ---------------------------------------------------------------------
-- 2. Upgrade public.journeys table with Phase 5 route & metadata columns
-- ---------------------------------------------------------------------
create table if not exists public.journeys (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Add all Phase 5 columns if they don't already exist on the table
alter table public.journeys add column if not exists title text;
alter table public.journeys add column if not exists title_en text;
alter table public.journeys add column if not exists description text;
alter table public.journeys add column if not exists description_en text;
alter table public.journeys add column if not exists era text;
alter table public.journeys add column if not exists tags text[] not null default '{}';
alter table public.journeys add column if not exists color text not null default '#b45309';
alter table public.journeys add column if not exists route geography(linestring, 4326);
alter table public.journeys add column if not exists site_ids uuid[] not null default '{}';
alter table public.journeys add column if not exists distance_km real;
alter table public.journeys add column if not exists status text not null default 'published';

-- If title_en was marked NOT NULL in 001_schema.sql, drop the constraint for flexibility
alter table public.journeys alter column title_en drop not null;

-- Sync title and description across schemas
update public.journeys
set
  title = coalesce(title, title_en),
  description = coalesce(description, description_en)
where title is null and title_en is not null;

update public.journeys
set
  title_en = coalesce(title_en, title),
  description_en = coalesce(description_en, description)
where title_en is null and title is not null;

-- Spatial and lookup indexes
create index if not exists journeys_route_gix on public.journeys using gist (route);
create index if not exists journeys_status_idx on public.journeys (status);
create index if not exists journeys_slug_idx   on public.journeys (slug);

-- ---------------------------------------------------------------------
-- 3. GeoJSON View for map rendering & distances
-- ---------------------------------------------------------------------
create or replace view public.journeys_geo as
select
  j.id,
  j.slug,
  coalesce(j.title, j.title_en, j.slug) as title,
  coalesce(j.description, j.description_en) as description,
  j.era,
  j.tags,
  j.color,
  coalesce(
    j.distance_km,
    case
      when j.route is not null
      then round((st_length(j.route::geography) / 1000.0)::numeric, 1)::real
      else 0.0
    end
  ) as distance_km,
  j.site_ids,
  j.status,
  case
    when j.route is not null
    then st_asgeojson(j.route::geometry)::jsonb
    else '{"type":"LineString","coordinates":[]}'::jsonb
  end as route_geojson,
  j.created_at,
  j.updated_at
from public.journeys j;

-- ---------------------------------------------------------------------
-- 4. RLS & Grants
-- ---------------------------------------------------------------------
alter table public.journeys enable row level security;

drop policy if exists journeys_public_read on public.journeys;
drop policy if exists "public read published journeys" on public.journeys;
create policy journeys_public_read on public.journeys
  for select using (status = 'published');

drop policy if exists journeys_service_all on public.journeys;
create policy journeys_service_all on public.journeys
  for all using (true) with check (true);

grant select on public.journeys to anon, authenticated;
grant select on public.journeys_geo to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Seed Curated Journeys linking existing seed sites
-- ---------------------------------------------------------------------
-- Route 1: Solanki Architecture & Craft Trail (Patan Patola -> Rani ki Vav -> Modhera)
insert into public.journeys (slug, title, title_en, description, description_en, era, tags, color, route, site_ids, status)
select
  'solanki-heritage-trail',
  'Solanki Architectural & Craft Corridor',
  'Solanki Architectural & Craft Corridor',
  'Follow the historic Solanki kingdom corridor in northern Gujarat. From the famed double-ikat Salvi weavers of Patan to the subterranean subterranean inverted temple of Rani ki Vav and the Sun Temple at Modhera, this route traces 11th-century hydraulics, devotional stone carving, and living textile arts.',
  'Follow the historic Solanki kingdom corridor in northern Gujarat. From the famed double-ikat Salvi weavers of Patan to the subterranean subterranean inverted temple of Rani ki Vav and the Sun Temple at Modhera, this route traces 11th-century hydraulics, devotional stone carving, and living textile arts.',
  '11th-12th century (Solanki)',
  array['solanki', 'stepwell', 'textile', 'unesco', 'gujarat'],
  '#b45309',
  st_setsrid(
    st_makeline(array[
      st_makepoint(72.1200, 23.8500), -- Patan Patola
      st_makepoint(72.1017, 23.8593), -- Rani ki Vav
      st_makepoint(72.1333, 23.5833), -- Modhera Sun Temple
      st_makepoint(72.5815, 23.1667)  -- Adalaj Vav
    ]),
    4326
  )::geography,
  array[
    (select id from public.sites where slug = 'patan-patola-weaving'),
    (select id from public.sites where slug = 'rani-ki-vav-patan')
  ],
  'published'
where exists (select 1 from public.sites where slug = 'rani-ki-vav-patan')
on conflict (slug) do update set
  title = excluded.title,
  title_en = excluded.title_en,
  description = excluded.description,
  description_en = excluded.description_en,
  era = excluded.era,
  tags = excluded.tags,
  color = excluded.color,
  route = excluded.route,
  site_ids = excluded.site_ids;

-- Route 2: Desert Forts, Stepwells & Printing Circuit
insert into public.journeys (slug, title, title_en, description, description_en, era, tags, color, route, site_ids, status)
select
  'rajasthan-desert-circuit',
  'Desert Forts, Stepwells & Textile Circuit',
  'Desert Forts, Stepwells & Textile Circuit',
  'Traverse the historic arid trade corridor of Rajasthan. Encounter the geometric stepwell architecture of Chand Baori at Abhaneri, the traditional mud-resist indigo printers of Bagru, and the imposing sandstone ramparts of Mehrangarh Fort rising above Marwar.',
  'Traverse the historic arid trade corridor of Rajasthan. Encounter the geometric stepwell architecture of Chand Baori at Abhaneri, the traditional mud-resist indigo printers of Bagru, and the imposing sandstone ramparts of Mehrangarh Fort rising above Marwar.',
  '8th-15th century',
  array['rajasthan', 'stepwell', 'fort', 'block-printing', 'marwar'],
  '#0d9488',
  st_setsrid(
    st_makeline(array[
      st_makepoint(76.6068, 27.0072), -- Chand Baori
      st_makepoint(75.5333, 26.8167), -- Bagru
      st_makepoint(73.0187, 26.2980)  -- Mehrangarh Fort
    ]),
    4326
  )::geography,
  array[
    (select id from public.sites where slug = 'chand-baori-abhaneri'),
    (select id from public.sites where slug = 'bagru-block-printing'),
    (select id from public.sites where slug = 'mehrangarh-fort-jodhpur')
  ],
  'published'
where exists (select 1 from public.sites where slug = 'chand-baori-abhaneri')
on conflict (slug) do update set
  title = excluded.title,
  title_en = excluded.title_en,
  description = excluded.description,
  description_en = excluded.description_en,
  era = excluded.era,
  tags = excluded.tags,
  color = excluded.color,
  route = excluded.route,
  site_ids = excluded.site_ids;
