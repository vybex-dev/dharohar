-- Run in the Supabase SQL Editor. Idempotent.
-- Stores LLM outputs only (never inputs), keyed by a sha256 of the request.

create table if not exists public.llm_cache (
  key        text primary key,
  task       text not null check (task in ('ocr', 'extract', 'parse_query', 'embed')),
  provider   text not null,
  model      text not null,
  output     jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists llm_cache_created_idx on public.llm_cache (created_at);

-- RLS on with no policies: only the service role can read or write.
alter table public.llm_cache enable row level security;

revoke all on public.llm_cache from anon, authenticated;
grant all on public.llm_cache to service_role;

notify pgrst, 'reload schema';