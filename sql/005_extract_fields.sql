-- Run in the Supabase SQL Editor. Idempotent.
alter table public.sites add column if not exists region text;
alter table public.sites add column if not exists crafts text[] not null default '{}';
alter table public.sites add column if not exists folklore_notes text;
alter table public.sites add column if not exists uncertain_fields text[] not null default '{}';
alter table public.sites add column if not exists field_confidence jsonb;
alter table public.sites add column if not exists extraction_confidence real
  check (extraction_confidence is null or extraction_confidence between 0 and 1);

-- Allow the new category value: drop whichever check mentions category, then re-add it.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.sites'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%category%'
  loop
    execute format('alter table public.sites drop constraint %I', c);
  end loop;
end $$;

alter table public.sites add constraint sites_category_check
  check (category in ('stepwell','fort','temple','palace','haveli','monument',
                      'craft','textile','manuscript','other'));

notify pgrst, 'reload schema';