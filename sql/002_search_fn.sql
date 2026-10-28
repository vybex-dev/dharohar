-- sql/002_search_fn.sql
-- Run in the Supabase SQL Editor. Idempotent.
--
-- search_sites(): hybrid search over published sites, combining three
-- independent signals and merging them with Reciprocal Rank Fusion (RRF):
--   1. semantic similarity  — pgvector cosine distance over doc_chunks.embedding
--   2. keyword relevance    — tsvector full-text rank over doc_chunks.tsv
--   3. geographic proximity — PostGIS ST_Distance/ST_DWithin over sites.location
--
-- Every argument is optional (defaults to null/'{}'::jsonb/20) so callers can
-- omit whichever signal doesn't apply — see app/api/search/route.ts for how
-- "no topic" / "no place" are handled before this function is even called.
--
-- RRF: for each signal, rank the matching sites 1..N by that signal alone,
-- then score = sum(1 / (60 + rank)) across whichever signals a site matched.
-- A site that matched more signals, or ranked well on the ones it did match,
-- scores higher. A site with no rank for a signal contributes 0 for it (not
-- a penalty — it just doesn't get that signal's boost). 60 is the constant
-- from the original RRF paper; it's a smoothing factor, not a magic number
-- tied to anything in this schema.
--
-- This relies on indexes already created in sql/001_schema.sql: the HNSW
-- index on doc_chunks.embedding, the GIN index on doc_chunks.tsv, and the
-- GiST index on sites.location. No new indexes are needed.

create or replace function public.search_sites(
  query_embedding vector(768)             default null,
  query_text      text                    default null,
  center          geography(point, 4326)  default null,
  radius_m        int                     default null,
  filters         jsonb                   default '{}'::jsonb,
  match_count     int                     default 20
)
returns table (
  site_id          uuid,
  slug             text,
  name             text,
  type             text,
  era              text,
  lat              double precision,
  lng              double precision,
  snippet          text,
  distance_m       double precision,
  score            real,
  matched_signals  text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select least(greatest(coalesce(match_count, 20), 1), 100) as match_count
  ),
  -- Candidate pool for the semantic ANN scan: more than match_count, so
  -- per-site aggregation below still has enough chunks to work with even
  -- when the single best-matching chunks are dominated by a few sites.
  semantic_candidate_limit as (
    select greatest((select match_count from params) * 10, 50) as n
  ),

  -- Published sites matching the non-vector filters: type, era (substring,
  -- case-insensitive) and a geo radius (when center AND radius_m are both
  -- given; if radius_m is omitted, every site is a candidate and distance
  -- becomes a pure ranking signal instead of a hard cutoff).
  filtered_sites as (
    select s.*
    from public.sites s
    where s.status = 'published'
      and (
        (filters ->> 'type') is null
        or s.category = (filters ->> 'type')
      )
      and (
        (filters ->> 'era') is null
        or s.period ilike '%' || (filters ->> 'era') || '%'
      )
      and (
        center is null
        or radius_m is null
        or s.location is null
        or ST_DWithin(s.location, center, radius_m)
      )
  ),

  -- Signal 1: semantic similarity. ORDER BY + LIMIT directly on doc_chunks
  -- lets Postgres use the HNSW index for an approximate nearest-neighbor
  -- scan; aggregating to site level happens AFTER that, not before — doing
  -- it the other way around (group by site_id, THEN order/limit) would
  -- force a full scan and ignore the index.
  semantic_chunks as (
    select c.site_id, c.text_en, 1 - (c.embedding <=> query_embedding) as sim
    from public.doc_chunks c
    where query_embedding is not null and c.embedding is not null
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
    group by sc.site_id
  ),
  semantic_ranked as (
    select site_id, sim, best_text, row_number() over (order by sim desc) as rnk
    from semantic
  ),

  -- Signal 2: keyword relevance via the GIN index on doc_chunks.tsv.
  -- websearch_to_tsquery is lenient (never raises on odd punctuation),
  -- matching the "safe fallback" spirit of the query parser upstream.
  keyword as (
    select
      c.site_id,
      max(ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text))) as kw_rank,
      (array_agg(
         ts_headline(
           'english', c.text_en, websearch_to_tsquery('english', query_text),
           'MaxFragments=1,MaxWords=40,MinWords=15,ShortWord=3,HighlightAll=false'
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

  -- Signal 3: geographic proximity. Already hard-filtered by filtered_sites
  -- when radius_m is given; here it's purely the ranking + reported distance.
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
    s.period                                              as era,
    st_y(s.location::geometry)                            as lat,
    st_x(s.location::geometry)                            as lng,
    coalesce(f.snippet_src, left(s.summary_en, 240), '')  as snippet,
    f.dist_m                                              as distance_m,
    f.rrf_score::real                                     as score,
    array_remove(array[
      case when f.semantic_rnk is not null then 'semantic' end,
      case when f.keyword_rnk  is not null then 'keyword'  end,
      case when f.geo_rnk      is not null then 'geo'      end
    ], null)                                              as matched_signals
  from fused f
  join public.sites s on s.id = f.site_id
  order by f.rrf_score desc, s.name_en asc
  limit (select match_count from params);
$$;

-- security definer: evaluated with the function owner's privileges, bypassing
-- RLS and the narrow per-column grants on doc_chunks (anon/authenticated have
-- NO select on doc_chunks.embedding or .tsv — see sql/001_schema.sql). Under
-- plain "security invoker" semantics, an anon/authenticated caller would get
-- a permission error the moment this function touches those columns. Safe
-- here ONLY because the function hardcodes `s.status = 'published'` itself
-- and returns no column that isn't already meant to be public — no raw
-- embeddings, no OCR text, no private asset fields. If you ever add a column
-- to the RETURNS TABLE, re-check that claim before shipping it.
--
-- The current search route always calls this via the service-role client
-- anyway (see app/api/search/route.ts), so the anon/authenticated grant below
-- is forward-looking, not load-bearing today. Drop it to `service_role` only
-- if you'd rather keep every read funneled through the API layer.
revoke all on function public.search_sites(vector, text, geography, int, jsonb, int)
  from public;
grant execute on function public.search_sites(vector, text, geography, int, jsonb, int)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';