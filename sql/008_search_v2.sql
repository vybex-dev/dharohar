-- sql/008_search_v2.sql
-- Run in the Supabase SQL Editor AFTER 002_search_fn.sql and 005_extract_fields.sql. Idempotent.
--
-- 1. era_bucket()      : maps the free-text sites.period onto five filterable buckets.
-- 2. search_sites()    : same hybrid RRF search as 002, plus
--                          - filter_types / filter_crafts / filter_eras (UI filters, multi-select)
--                          - semantic_sim, crafts, state, district, era_bucket in the result
--                          - keyword snippets marked with « » (the UI highlights them; no HTML)
--                          - placeholder embeddings and weak matches no longer count as a
--                            "semantic" hit, so the "why this matched" chip never overstates.
-- 3. related_sites()   : nearest published sites to a site, by embedding centroid. Falls back
--                        to category / state / tag overlap while only placeholder vectors exist.
-- 4. Backfills `crafts` for the two seed craft sites (seed rows predate sql/005).

-- ---------------------------------------------------------------------
-- 1. era_bucket
-- ---------------------------------------------------------------------
create or replace function public.era_bucket(period text)
returns text
language plpgsql
immutable
as $$
declare
  p text := lower(coalesce(period, ''));
  century int;
  yr int;
begin
  if btrim(p) = '' then
    return null;
  end if;
  if p ~ '\m(bce|bc|ancient|vedic|mauryan|indus)\M' then
    return 'ancient';
  end if;

  -- "11th century", "8th-9th century": the first ordinal wins.
  century := substring(p from '(\d{1,2})(?:st|nd|rd|th)')::int;
  if century is null then
    yr := substring(p from '\m(\d{3,4})\M')::int;
    if yr is not null then
      century := ((yr - 1) / 100) + 1;
    end if;
  end if;

  if century is not null then
    return case
      when century <= 5  then 'ancient'
      when century <= 12 then 'early-medieval'
      when century <= 17 then 'late-medieval'
      else 'colonial-modern'
    end;
  end if;

  if p ~ '(tradition|contemporary|living|present)' then
    return 'living';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. search_sites v2 (the return type changes, so the old one must go first)
-- ---------------------------------------------------------------------
drop function if exists public.search_sites(vector, text, geography, int, jsonb, int);
drop function if exists public.search_sites(vector, text, geography, int, jsonb, int, text[], text[], text[], real);

create or replace function public.search_sites(
  query_embedding vector(768)             default null,
  query_text      text                    default null,
  center          geography(point, 4326)  default null,
  radius_m        int                     default null,
  filters         jsonb                   default '{}'::jsonb,  -- LLM-parsed: {type?, era?}
  match_count     int                     default 20,
  filter_types    text[]                  default null,         -- UI: category in (...)
  filter_crafts   text[]                  default null,         -- UI: lower-cased craft names
  filter_eras     text[]                  default null,         -- UI: era_bucket() values
  min_similarity  real                    default 0.5           -- below this, not a semantic hit
)
returns table (
  site_id          uuid,
  slug             text,
  name             text,
  type             text,
  era              text,
  era_bucket       text,
  state            text,
  district         text,
  crafts           text[],
  lat              double precision,
  lng              double precision,
  snippet          text,
  distance_m       double precision,
  semantic_sim     real,
  score            real,
  matched_signals  text[]
)
language sql
stable
security definer
set search_path = public, extensions  -- postgis + pgvector live in `extensions`
as $$
  with params as (
    select least(greatest(coalesce(match_count, 20), 1), 100) as match_count
  ),
  semantic_candidate_limit as (
    select greatest((select match_count from params) * 10, 50) as n
  ),

  filtered_sites as (
    select s.*
    from public.sites s
    where s.status = 'published'
      and ((filters ->> 'type') is null or s.category = (filters ->> 'type'))
      and ((filters ->> 'era')  is null or s.period ilike '%' || (filters ->> 'era') || '%')
      and (filter_types is null or cardinality(filter_types) = 0
           or s.category = any(filter_types))
      and (filter_eras is null or cardinality(filter_eras) = 0
           or public.era_bucket(s.period) = any(filter_eras))
      and (filter_crafts is null or cardinality(filter_crafts) = 0
           or exists (select 1 from unnest(s.crafts) cr where lower(cr) = any(filter_crafts)))
      and (center is null or radius_m is null or s.location is null
           or ST_DWithin(s.location, center, radius_m::double precision))
  ),

  -- Signal 1: semantic. ANN first (uses the HNSW index), aggregate to site after.
  -- Placeholder vectors (seed data) and weak matches are not semantic hits.
  semantic_chunks as (
    select c.site_id, c.text_en, 1 - (c.embedding <=> query_embedding) as sim
    from public.doc_chunks c
    where query_embedding is not null
      and c.embedding is not null
      and c.embedding_model is distinct from 'placeholder'
    order by c.embedding <=> query_embedding
    limit (select n from semantic_candidate_limit)
  ),
  semantic as (
    select
      sc.site_id,
      max(sc.sim) as sim,
      (array_agg(sc.text_en order by sc.sim desc))[1] as best_text
    from semantic_chunks sc
    join filtered_sites s on s.id = sc.site_id
    where sc.sim >= coalesce(min_similarity, 0.5)
    group by sc.site_id
  ),
  semantic_ranked as (
    select site_id, sim, best_text, row_number() over (order by sim desc) as rnk
    from semantic
  ),

  -- Signal 2: keyword (GIN on tsv). Matches are wrapped in « » for the UI.
  keyword as (
    select
      c.site_id,
      max(ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text))) as kw_rank,
      (array_agg(
         ts_headline(
           'english', c.text_en, websearch_to_tsquery('english', query_text),
           'StartSel=«,StopSel=»,MaxFragments=1,MaxWords=40,MinWords=15,ShortWord=3,HighlightAll=false'
         )
         order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc
       ))[1] as headline
    from public.doc_chunks c
    join filtered_sites s on s.id = c.site_id
    where query_text is not null
      and btrim(query_text) <> ''
      and c.tsv @@ websearch_to_tsquery('english', query_text)
    group by c.site_id
  ),
  keyword_ranked as (
    select site_id, kw_rank, headline, row_number() over (order by kw_rank desc) as rnk
    from keyword
  ),

  -- Signal 3: geographic proximity.
  geo as (
    select s.id as site_id, ST_Distance(s.location, center) as dist_m
    from filtered_sites s
    where center is not null and s.location is not null
  ),
  geo_ranked as (
    select site_id, dist_m, row_number() over (order by dist_m asc) as rnk
    from geo
  ),

  candidates as (
    select site_id from semantic_ranked
    union
    select site_id from keyword_ranked
    union
    select site_id from geo_ranked
  ),

  fused as (
    select
      c.site_id,
      sr.rnk  as semantic_rnk,
      sr.sim  as semantic_sim,
      kr.rnk  as keyword_rnk,
      gr.rnk  as geo_rnk,
      coalesce(1.0 / (60 + sr.rnk), 0)
        + coalesce(1.0 / (60 + kr.rnk), 0)
        + coalesce(1.0 / (60 + gr.rnk), 0) as rrf_score,
      coalesce(kr.headline, left(sr.best_text, 240)) as snippet_src,
      gr.dist_m
    from candidates c
    left join semantic_ranked sr on sr.site_id = c.site_id
    left join keyword_ranked  kr on kr.site_id = c.site_id
    left join geo_ranked      gr on gr.site_id = c.site_id
  )

  select
    f.site_id,
    s.slug,
    s.name_en                                            as name,
    s.category                                           as type,
    s.period                                             as era,
    public.era_bucket(s.period)                          as era_bucket,
    s.state,
    s.district,
    s.crafts,
    st_y(s.location::geometry)                           as lat,
    st_x(s.location::geometry)                           as lng,
    coalesce(f.snippet_src, left(s.summary_en, 240), '') as snippet,
    f.dist_m                                             as distance_m,
    f.semantic_sim::real                                 as semantic_sim,
    f.rrf_score::real                                    as score,
    array_remove(array[
      case when f.semantic_rnk is not null then 'semantic' end,
      case when f.keyword_rnk  is not null then 'keyword'  end,
      case when f.geo_rnk      is not null then 'geo'      end
    ], null)                                             as matched_signals
  from fused f
  join public.sites s on s.id = f.site_id
  order by f.rrf_score desc, s.name_en asc
  limit (select match_count from params);
$$;

-- security definer is safe here for the same reason as in 002: it hardcodes
-- status = 'published' and returns no embeddings, OCR text or private asset fields.
revoke all on function public.search_sites(vector, text, geography, int, jsonb, int, text[], text[], text[], real)
  from public;
grant execute on function public.search_sites(vector, text, geography, int, jsonb, int, text[], text[], text[], real)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. related_sites
-- ---------------------------------------------------------------------
create or replace function public.related_sites(
  p_site_id   uuid,
  match_count int default 6
)
returns table (
  site_id    uuid,
  slug       text,
  name       text,
  type       text,
  era        text,
  state      text,
  district   text,
  lat        double precision,
  lng        double precision,
  similarity real,   -- cosine similarity when basis = 'embedding'; a plain overlap score otherwise
  basis      text    -- 'embedding' | 'metadata'
)
language sql
stable
security definer
set search_path = public, extensions  -- postgis + pgvector live in `extensions`
as $$
  with params as (
    select least(greatest(coalesce(match_count, 6), 1), 24) as n
  ),
  me as (
    select s.id, s.category, s.state, s.tags
    from public.sites s
    where s.id = p_site_id and s.status = 'published'
  ),
  -- Centroid of this site's real (non-placeholder) chunk embeddings.
  centroid as (
    select avg(c.embedding) as v
    from public.doc_chunks c
    join me on me.id = c.site_id
    where c.embedding is not null
      and c.embedding_model is distinct from 'placeholder'
  ),
  ann as (
    select c.site_id, 1 - (c.embedding <=> (select v from centroid)) as sim
    from public.doc_chunks c
    where (select v from centroid) is not null
      and c.embedding is not null
      and c.embedding_model is distinct from 'placeholder'
      and c.site_id <> p_site_id
    order by c.embedding <=> (select v from centroid)
    limit 200
  ),
  emb as (
    select a.site_id, max(a.sim)::real as similarity, 'embedding'::text as basis
    from ann a
    join public.sites s on s.id = a.site_id and s.status = 'published'
    group by a.site_id
    order by max(a.sim) desc
    limit (select n from params)
  ),
  meta as (
    select m.site_id, m.score::real as similarity, 'metadata'::text as basis
    from (
      select
        s.id as site_id,
        (case when s.category = me.category then 2 else 0 end
         + case when s.state is not null and s.state = me.state then 1 else 0 end
         + coalesce(cardinality(array(
             select unnest(s.tags) intersect select unnest(me.tags))), 0)) as score
      from public.sites s
      cross join me
      where s.status = 'published' and s.id <> p_site_id
    ) m
    where m.score > 0
      and not exists (select 1 from emb)
    order by m.score desc
    limit (select n from params)
  )
  select
    r.site_id,
    s.slug,
    s.name_en,
    s.category,
    s.period,
    s.state,
    s.district,
    st_y(s.location::geometry),
    st_x(s.location::geometry),
    r.similarity,
    r.basis
  from (select * from emb union all select * from meta) r
  join public.sites s on s.id = r.site_id
  order by r.similarity desc, s.name_en asc;
$$;

revoke all on function public.related_sites(uuid, int) from public;
grant execute on function public.related_sites(uuid, int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Seed craft backfill (only where crafts is still empty)
-- ---------------------------------------------------------------------
update public.sites set crafts = array['double ikat', 'silk weaving']
 where slug = 'patan-patola-weaving' and crafts = '{}';
update public.sites set crafts = array['block printing', 'dabu resist', 'natural indigo dyeing']
 where slug = 'bagru-block-printing' and crafts = '{}';

-- ---------------------------------------------------------------------
-- 5. sites_geo: expose crafts + region so /api/sites can feed the filters.
--    New columns are appended at the END, which create-or-replace allows.
-- ---------------------------------------------------------------------
create or replace view public.sites_geo with (security_invoker = true) as
select
  id, slug, name_en, name_local, category, state, district, address_text,
  summary_en, period, tags, location_source, location_confidence,
  origin, status,
  st_y(location::geometry) as lat,
  st_x(location::geometry) as lng,
  created_at, updated_at,
  region, crafts
from public.sites;

notify pgrst, 'reload schema';