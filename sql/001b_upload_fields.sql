-- Title and notes entered on the upload form (private: anon has no grant on them)
alter table public.assets add column if not exists title text;
alter table public.assets add column if not exists notes text;

-- Ask the API layer to refresh its schema cache
notify pgrst, 'reload schema';