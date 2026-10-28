import { z } from "zod";

/* Allowed values for `type`. Stored in sites.category (see sql/005_extract_fields.sql). */
export const EXTRACT_TYPES = [
  "stepwell",
  "fort",
  "temple",
  "craft",
  "manuscript",
  "other",
] as const;
export type ExtractType = (typeof EXTRACT_TYPES)[number];

/* Every field that gets a confidence score and can be listed as uncertain. */
export const EXTRACT_FIELDS = [
  "name",
  "name_local",
  "type",
  "era",
  "crafts",
  "place_name",
  "region",
  "state",
  "district",
  "summary_en",
  "text_en",
  "folklore_notes",
] as const;
export type ExtractField = (typeof EXTRACT_FIELDS)[number];

export function isExtractField(v: string): v is ExtractField {
  return (EXTRACT_FIELDS as readonly string[]).includes(v);
}

/* ---------- lenient field helpers: normalise common model quirks ---------- */

const NULL_WORDS =
  /^(null|none|n\/a|na|nil|unknown|not specified|not available|-)$/i;

function cleanNullable(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" || NULL_WORDS.test(s) ? null : s;
  }
  return v; // wrong types still fail validation, which triggers the repair attempt
}

const nullableText = z.preprocess(cleanNullable, z.string().nullable());

const textOrEmpty = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string().transform((s) => s.trim()),
);

const typeField = z.preprocess((v) => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (EXTRACT_TYPES as readonly string[]).includes(s) ? s : "other";
}, z.enum(EXTRACT_TYPES));

const craftsField = z.preprocess(
  (v) => (v === undefined || v === null ? [] : v),
  z.array(z.string()).transform((items) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
      const t = item.trim();
      const key = t.toLowerCase();
      if (t !== "" && !seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
    return out.slice(0, 12);
  }),
);

/* A score of 0-1 (percentages like 85 are rescaled). Missing or invalid becomes 0 = "no confidence". */
const confidence = z
  .preprocess(
    (v) => (typeof v === "number" && v > 1 && v <= 100 ? v / 100 : v),
    z.number().min(0).max(1),
  )
  .catch(0);

const fieldConfidence = z.preprocess(
  (v) => (v && typeof v === "object" ? v : {}),
  z.object({
    name: confidence,
    name_local: confidence,
    type: confidence,
    era: confidence,
    crafts: confidence,
    place_name: confidence,
    region: confidence,
    state: confidence,
    district: confidence,
    summary_en: confidence,
    text_en: confidence,
    folklore_notes: confidence,
  }),
);

const uncertainFields = z.preprocess(
  (v) => (Array.isArray(v) ? v : []),
  z.array(z.unknown()).transform((items) => {
    const out: ExtractField[] = [];
    for (const item of items) {
      if (typeof item !== "string") continue;
      const key = item.trim().toLowerCase();
      if (isExtractField(key) && !out.includes(key)) out.push(key);
    }
    return out;
  }),
);

/* =========================================================================
 * Output of callLLM("extract")
 * ========================================================================= */
export const ExtractOutputSchema = z.object({
  name: nullableText, // English name of the site, object, craft or document
  name_local: nullableText, // name in the original script
  type: typeField,
  era: nullableText, // as stated in the text, e.g. "11th century CE"
  crafts: craftsField, // craft traditions, techniques or materials mentioned
  place_name: nullableText, // a string a geocoder can resolve
  region: nullableText, // broader area, e.g. "North Gujarat"
  state: nullableText,
  district: nullableText,
  summary_en: textOrEmpty, // 3 to 4 sentences; "" only in translate-only calls
  text_en: textOrEmpty, // full English translation; "" for English input or no text
  folklore_notes: nullableText, // legends, local beliefs, oral traditions stated in the text
  field_confidence: fieldConfidence, // per-field 0-1; 0 when the field is null
  uncertain_fields: uncertainFields, // fields the review screen should highlight
});

export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;
