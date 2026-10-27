-- Run AFTER sql/001_schema.sql. Idempotent: safe to re-run.
-- Coordinates are approximate (4 decimals). Verify them on a map before the demo.
-- Embeddings are PLACEHOLDERS (embedding_model = 'placeholder'): keyword search
-- over tsv works, but semantic search rankings are meaningless until real
-- vectors are regenerated.

-- Temporary helper: deterministic non-zero 768-dim vector per seed value.
create or replace function public.tmp_fake_embedding(seed int)
returns vector
language sql
as $$
  select array_agg(sin(seed::double precision * 1000.0 + i) order by i)::vector
  from generate_series(1, 768) as i
$$;

-- ---------- sites ----------
insert into public.sites
  (slug, name_en, name_local, category, state, district, address_text,
   location, location_source, location_confidence, summary_en, period, tags,
   origin, status)
values
 ('rani-ki-vav-patan', 'Rani ki Vav', 'રાણકી વાવ', 'stepwell', 'Gujarat', 'Patan',
  'Patan, Gujarat',
  st_setsrid(st_makepoint(72.1017, 23.8593), 4326)::geography, 'seed', 0.9,
  'An elaborately carved stepwell at Patan on the banks of the Saraswati river, built under the Solanki dynasty and commonly attributed to Queen Udayamati in memory of her husband Bhimdev I. It is designed as an inverted temple, with descending levels of pillared galleries and hundreds of sculptures, many depicting avatars of Vishnu. Silt buried it for centuries until the Archaeological Survey of India excavated it in the 20th century; it is a UNESCO World Heritage Site.',
  '11th century (Solanki)',
  array['stepwell','solanki','unesco','sculpture','water-architecture'],
  'seed', 'published'),

 ('chand-baori-abhaneri', 'Chand Baori', 'चाँद बावड़ी', 'stepwell', 'Rajasthan', 'Dausa',
  'Abhaneri, Dausa district, Rajasthan',
  st_setsrid(st_makepoint(76.6068, 27.0072), 4326)::geography, 'seed', 0.9,
  'One of the deepest and largest stepwells in India, at the village of Abhaneri beside the Harshat Mata temple. It is usually dated to the 8th-9th century and attributed to King Chanda of the Nikumbha dynasty. Roughly 13 storeys of narrow steps descend in a strikingly geometric pattern to the water, which kept the surrounding area cool in the desert heat.',
  '8th-9th century',
  array['stepwell','nikumbha','geometric','water-architecture','abhaneri'],
  'seed', 'published'),

 ('mehrangarh-fort-jodhpur', 'Mehrangarh Fort', 'मेहरानगढ़ किला', 'fort', 'Rajasthan', 'Jodhpur',
  'Mehrangarh, Jodhpur, Rajasthan',
  st_setsrid(st_makepoint(73.0187, 26.2980), 4326)::geography, 'seed', 0.9,
  'A massive sandstone fort rising above Jodhpur, founded in 1459 by Rao Jodha of the Rathore clan. Its courtyards and palaces, including Moti Mahal, Phool Mahal and Sheesh Mahal, hold fine jharokha stone latticework, painted ceilings and gilded interiors. Today part of it is a museum displaying royal palanquins, arms, textiles and miniature paintings.',
  '15th century onward',
  array['fort','rathore','marwar','sandstone','museum','jharokha'],
  'seed', 'published'),

 ('patan-patola-weaving', 'Patan Patola Weaving', 'પાટણ પટોળા', 'textile', 'Gujarat', 'Patan',
  'Salvi weavers, Patan, Gujarat',
  st_setsrid(st_makepoint(72.1200, 23.8500), 4326)::geography, 'seed', 0.6,
  'Patola is a double-ikat silk textile woven in Patan, where both warp and weft threads are tied and resist-dyed in the pattern before weaving, so the design must align perfectly on the loom. A single sari can take many months to complete. The craft is held by a few Salvi families, and tradition links its arrival to the Solanki era. The coordinates here are approximate for the town.',
  'Traditional; Solanki-era origins',
  array['textile','craft','double-ikat','silk','salvi','intangible-heritage'],
  'seed', 'published'),

 ('bagru-block-printing', 'Bagru Hand Block Printing', 'बगरू छपाई', 'craft', 'Rajasthan', 'Jaipur',
  'Bagru village, Jaipur district, Rajasthan',
  st_setsrid(st_makepoint(75.5333, 26.8167), 4326)::geography, 'seed', 0.6,
  'Bagru is a village near Jaipur known for hand block printing on cotton, practised traditionally by the Chhipa community. Carved wooden blocks stamp motifs in natural dyes such as indigo, and the dabu technique uses a mud resist to create deep, layered colour. The coordinates here are approximate for the village.',
  'Traditional craft',
  array['craft','textile','block-printing','dabu','indigo','chhipa'],
  'seed', 'published')
on conflict (slug) do update set
  name_en = excluded.name_en, name_local = excluded.name_local,
  category = excluded.category, state = excluded.state, district = excluded.district,
  address_text = excluded.address_text, location = excluded.location,
  location_source = excluded.location_source,
  location_confidence = excluded.location_confidence,
  summary_en = excluded.summary_en, period = excluded.period, tags = excluded.tags,
  origin = excluded.origin, status = excluded.status;

-- ---------- chunks: one per seed site (delete then insert keeps it idempotent) ----------
delete from public.doc_chunks
where site_id in (select id from public.sites where origin = 'seed');

insert into public.doc_chunks
  (site_id, asset_id, chunk_index, text_en, language, content_hash, embedding, embedding_model)
select s.id, null, 0, s.summary_en, 'en',
       encode(sha256(convert_to(s.summary_en, 'utf8')), 'hex'),
       public.tmp_fake_embedding(hashtext(s.slug) % 10000),
       'placeholder'
from public.sites s
where s.origin = 'seed';

-- ---------- one sample journey ----------
insert into public.journeys (slug, title_en, description_en, status)
values ('stone-and-cloth',
        'Stone and Cloth: A Western India Sampler',
        'Two great stepwells, a desert fort, and two living textile crafts across Gujarat and Rajasthan.',
        'published')
on conflict (slug) do update set
  title_en = excluded.title_en,
  description_en = excluded.description_en,
  status = excluded.status;

delete from public.journey_stops
where journey_id = (select id from public.journeys where slug = 'stone-and-cloth');

insert into public.journey_stops (journey_id, site_id, position, note)
select (select id from public.journeys where slug = 'stone-and-cloth'),
       (select id from public.sites where slug = 'rani-ki-vav-patan'),
       1, 'Start with the carved galleries of the stepwell.';

insert into public.journey_stops (journey_id, site_id, position, note)
select (select id from public.journeys where slug = 'stone-and-cloth'),
       (select id from public.sites where slug = 'patan-patola-weaving'),
       2, 'Same town: see double-ikat silk being woven.';

insert into public.journey_stops (journey_id, site_id, position, note)
select (select id from public.journeys where slug = 'stone-and-cloth'),
       (select id from public.sites where slug = 'mehrangarh-fort-jodhpur'),
       3, 'Head west to the great fort of Marwar.';

insert into public.journey_stops (journey_id, site_id, position, note)
select (select id from public.journeys where slug = 'stone-and-cloth'),
       (select id from public.sites where slug = 'bagru-block-printing'),
       4, 'Block-printing villages near Jaipur.';

insert into public.journey_stops (journey_id, site_id, position, note)
select (select id from public.journeys where slug = 'stone-and-cloth'),
       (select id from public.sites where slug = 'chand-baori-abhaneri'),
       5, 'End at the geometric stepwell of Abhaneri.';

drop function if exists public.tmp_fake_embedding(int);