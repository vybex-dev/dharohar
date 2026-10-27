-- =====================================================================
-- Dharohar Phase 1 schema. Idempotent: safe to re-run.
-- NOTE: "create table if not exists" will NOT alter an existing table.
-- While developing, to wipe and rebuild, run this first (DESTROYS DATA):
--   drop schema public cascade; create schema public;
--   grant usage on schema public to anon, authenticated, service_role;
--   (then re-run sql/000_health.sql and this file)
-- =====================================================================

create extension if not exists postgis with schema extensions;
create extension if not exists vector  with schema extensions;

-- ---------- helper: updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- sites
-- =====================================================================
create table if not exists public.sites (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique
                      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_en             text not null,
  name_local          text,
  category            text not null default 'other'
                      check (category in ('stepwell','fort','temple','palace','haveli',
                                          'monument','craft','textile','other')),
  state               text,
  district            text,
  address_text        text,
  location            geography(point, 4326),
  location_source     text check (location_source in ('exif','geocoded','manual','seed')),
  location_confidence real check (location_confidence between 0 and 1),
  summary_en          text,
  period              text,
  tags                text[] not null default '{}',
  origin              text not null default 'upload' check (origin in ('seed','upload')),
  status              text not null default 'draft'
                      check (status in ('draft','published','archived')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists sites_location_gix on public.sites using gist (location);
create index if not exists sites_status_idx   on public.sites (status);
create index if not exists sites_tags_gin     on public.sites using gin (tags);

-- =====================================================================
-- assets (uploaded photos / scans)
-- =====================================================================
create table if not exists public.assets (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid references public.sites(id) on delete set null,
  kind              text not null check (kind in ('photo','scan')),
  storage_bucket    text not null,
  storage_path      text not null,
  original_filename text,
  mime_type         text,
  size_bytes        bigint check (size_bytes >= 0),
  caption           text,
  content_hash      text,                       -- sha256 hex of file bytes (cache key)
  exif_location     geography(point, 4326),
  exif_taken_at     timestamptz,
  language_detected text,
  ocr_text          text,                       -- original script
  text_en           text,                       -- English translation
  ocr_provider      text,
  ocr_model         text,
  ocr_confidence    real check (ocr_confidence between 0 and 1),
  extract_provider  text,
  extract_model     text,
  extracted         jsonb,                      -- structured extraction result
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create index if not exists assets_site_idx         on public.assets (site_id);
create index if not exists assets_content_hash_idx on public.assets (content_hash);
create index if not exists assets_exif_gix         on public.assets using gist (exif_location);

-- =====================================================================
-- doc_chunks (searchable text + embeddings)
-- =====================================================================
create table if not exists public.doc_chunks (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references public.sites(id) on delete cascade,
  asset_id        uuid references public.assets(id) on delete cascade,
  chunk_index     int  not null default 0 check (chunk_index >= 0),
  text_en         text not null,
  text_original   text,
  language        text,
  content_hash    text,                         -- sha256 hex of text_en (embedding cache key)
  embedding       vector(768),
  embedding_model text,                         -- 'placeholder' for seed data
  tsv             tsvector generated always as
                    (to_tsvector('english', coalesce(text_en, ''))) stored,
  created_at      timestamptz not null default now(),
  unique (asset_id, chunk_index)                -- makes the embed stage idempotent
);

create index if not exists doc_chunks_site_idx on public.doc_chunks (site_id);
create index if not exists doc_chunks_hash_idx on public.doc_chunks (content_hash);
create index if not exists doc_chunks_tsv_gin  on public.doc_chunks using gin (tsv);
create index if not exists doc_chunks_embedding_hnsw
  on public.doc_chunks using hnsw (embedding vector_cosine_ops);

-- =====================================================================
-- jobs: one pipeline per asset. `stage` = the stage the NEXT advance call runs.
--   uploaded -> ocr -> extract -> geocode -> embed -> published
-- =====================================================================
create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null unique references public.assets(id) on delete cascade,
  site_id      uuid references public.sites(id) on delete set null,
  stage        text not null default 'uploaded'
               check (stage in ('uploaded','ocr','extract','geocode','embed','published')),
  status       text not null default 'pending'
               check (status in ('pending','running','done','failed')),
  attempts     int  not null default 0 check (attempts >= 0),
  max_attempts int  not null default 3 check (max_attempts > 0),
  locked_at    timestamptz,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (status <> 'running' or locked_at is not null),
  check (stage <> 'published' or status = 'done')
);

create index if not exists jobs_status_idx on public.jobs (status, locked_at);

-- Outputs of completed stages. unique(job_id, stage) = a stage can only
-- be recorded once per job; re-completion upserts instead of duplicating.
create table if not exists public.job_stage_runs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  stage       text not null check (stage in ('uploaded','ocr','extract','geocode','embed')),
  provider    text,
  model       text,
  output      jsonb not null default '{}'::jsonb,
  finished_at timestamptz not null default now(),
  unique (job_id, stage)
);

-- =====================================================================
-- journeys (curated routes) + stops
-- =====================================================================
create table if not exists public.journeys (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique
                 check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title_en       text not null,
  description_en text,
  status         text not null default 'draft' check (status in ('draft','published')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.journey_stops (
  journey_id uuid not null references public.journeys(id) on delete cascade,
  site_id    uuid not null references public.sites(id)    on delete cascade,
  position   int  not null check (position >= 1),
  note       text,
  primary key (journey_id, site_id),
  unique (journey_id, position)
);

create index if not exists journey_stops_site_idx on public.journey_stops (site_id);

-- =====================================================================
-- geocode_cache (Nominatim results; check here before calling the API)
-- =====================================================================
create table if not exists public.geocode_cache (
  query_norm   text primary key,               -- lowercased, trimmed, whitespace-collapsed
  found        boolean not null,
  location     geography(point, 4326),
  display_name text,
  raw          jsonb,
  provider     text not null default 'nominatim',
  created_at   timestamptz not null default now()
);

-- =====================================================================
-- view: sites with plain lat/lng (RLS of the caller applies)
-- =====================================================================
drop view if exists public.sites_geo;
create view public.sites_geo with (security_invoker = true) as
select
  id, slug, name_en, name_local, category, state, district, address_text,
  summary_en, period, tags, location_source, location_confidence,
  origin, status,
  st_y(location::geometry) as lat,
  st_x(location::geometry) as lng,
  created_at, updated_at
from public.sites;

-- =====================================================================
-- updated_at triggers
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['sites','assets','jobs','journeys'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$s
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- =====================================================================
-- Job stage functions (atomic; call with the service role only)
-- =====================================================================

-- Claim the job's current stage. Returns 0 rows if it can't be claimed
-- (already running with a fresh lock, finished, or out of attempts).
create or replace function public.claim_job_stage(p_job_id uuid, p_lock_seconds int default 120)
returns setof public.jobs
language plpgsql
set search_path = public
as $$
begin
  return query
  update public.jobs j
     set status    = 'running',
         locked_at = now(),
         attempts  = j.attempts + 1,
         error     = null
   where j.id = p_job_id
     and j.stage <> 'published'
     and j.attempts < j.max_attempts
     and (
           j.status in ('pending', 'failed')
        or (j.status = 'running'
            and j.locked_at < now() - make_interval(secs => p_lock_seconds))
     )
  returning j.*;
end;
$$;

-- Mark the stage done and advance. Compare-and-swap on (stage, running):
-- a duplicate or late call changes nothing and returns the current row.
create or replace function public.complete_job_stage(
  p_job_id   uuid,
  p_stage    text,
  p_output   jsonb default '{}'::jsonb,
  p_provider text  default null,
  p_model    text  default null
)
returns setof public.jobs
language plpgsql
set search_path = public
as $$
declare
  v_next text;
begin
  v_next := case p_stage
              when 'uploaded' then 'ocr'
              when 'ocr'      then 'extract'
              when 'extract'  then 'geocode'
              when 'geocode'  then 'embed'
              when 'embed'    then 'published'
            end;
  if v_next is null then
    raise exception 'Stage % cannot be completed', p_stage;
  end if;

  update public.jobs j
     set stage     = v_next,
         status    = case when v_next = 'published' then 'done' else 'pending' end,
         attempts  = 0,
         locked_at = null,
         error     = null
   where j.id = p_job_id and j.stage = p_stage and j.status = 'running';

  if found then
    insert into public.job_stage_runs (job_id, stage, provider, model, output)
    values (p_job_id, p_stage, p_provider, p_model, coalesce(p_output, '{}'::jsonb))
    on conflict (job_id, stage) do update
      set provider    = excluded.provider,
          model       = excluded.model,
          output      = excluded.output,
          finished_at = now();
  end if;

  return query select * from public.jobs where id = p_job_id;
end;
$$;

create or replace function public.fail_job_stage(p_job_id uuid, p_stage text, p_error text)
returns setof public.jobs
language plpgsql
set search_path = public
as $$
begin
  update public.jobs j
     set status    = 'failed',
         locked_at = null,
         error     = left(coalesce(p_error, 'unknown error'), 2000)
   where j.id = p_job_id and j.stage = p_stage and j.status = 'running';

  return query select * from public.jobs where id = p_job_id;
end;
$$;

revoke all on function public.claim_job_stage(uuid, int)                         from public, anon, authenticated;
revoke all on function public.complete_job_stage(uuid, text, jsonb, text, text)  from public, anon, authenticated;
revoke all on function public.fail_job_stage(uuid, text, text)                   from public, anon, authenticated;
grant execute on function public.claim_job_stage(uuid, int)                        to service_role;
grant execute on function public.complete_job_stage(uuid, text, jsonb, text, text) to service_role;
grant execute on function public.fail_job_stage(uuid, text, text)                  to service_role;

-- =====================================================================
-- Row Level Security
-- Public: read PUBLISHED content only. All writes: service role only
-- (service_role bypasses RLS; no insert/update/delete policies exist).
-- =====================================================================
alter table public.sites          enable row level security;
alter table public.assets         enable row level security;
alter table public.doc_chunks     enable row level security;
alter table public.jobs           enable row level security;   -- no policies = private
alter table public.job_stage_runs enable row level security;   -- no policies = private
alter table public.journeys       enable row level security;
alter table public.journey_stops  enable row level security;
alter table public.geocode_cache  enable row level security;   -- no policies = private

drop policy if exists "public read published sites" on public.sites;
create policy "public read published sites" on public.sites
  for select to anon, authenticated
  using (status = 'published');

drop policy if exists "public read chunks of published sites" on public.doc_chunks;
create policy "public read chunks of published sites" on public.doc_chunks
  for select to anon, authenticated
  using (exists (select 1 from public.sites s
                 where s.id = doc_chunks.site_id and s.status = 'published'));

drop policy if exists "public read assets of published sites" on public.assets;
create policy "public read assets of published sites" on public.assets
  for select to anon, authenticated
  using (exists (select 1 from public.sites s
                 where s.id = assets.site_id and s.status = 'published'));

drop policy if exists "public read published journeys" on public.journeys;
create policy "public read published journeys" on public.journeys
  for select to anon, authenticated
  using (status = 'published');

drop policy if exists "public read stops of published journeys" on public.journey_stops;
create policy "public read stops of published journeys" on public.journey_stops
  for select to anon, authenticated
  using (exists (select 1 from public.journeys j
                 where j.id = journey_stops.journey_id and j.status = 'published'));

-- =====================================================================
-- Grants (explicit, because this project does not auto-grant)
-- =====================================================================
grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables in schema public from anon, authenticated;

grant select on public.sites, public.journeys, public.journey_stops, public.sites_geo
  to anon, authenticated;

-- Column-level: embeddings, OCR text, hashes and EXIF stay private.
-- Consequence: anon must list columns; `select *` on these two tables fails.
grant select (id, site_id, asset_id, chunk_index, text_en, language)
  on public.doc_chunks to anon, authenticated;
grant select (id, site_id, kind, storage_bucket, storage_path, mime_type, caption)
  on public.assets to anon, authenticated;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- =====================================================================
-- Storage bucket (private). Name must equal SUPABASE_STORAGE_BUCKET.
-- If this insert is refused in your project, create the bucket in the
-- dashboard instead (see the instructions below the file).
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'heritage-uploads', 'heritage-uploads', false,
  10485760,  -- 10 MB per file: my choice, adjust as needed
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;