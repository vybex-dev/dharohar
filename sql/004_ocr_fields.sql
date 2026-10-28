-- Run in the Supabase SQL Editor. Idempotent.
alter table public.doc_chunks
  add column if not exists ocr_confidence real
  check (ocr_confidence is null or ocr_confidence between 0 and 1);

notify pgrst, 'reload schema';