// lib/review-schema.ts
// Zod validation for POST /api/review/[jobId].
import { z } from "zod";
import { EXTRACT_FIELDS } from "@/lib/extract-schema";
import { CATEGORIES } from "@/lib/facets";

const optionalText = (max: number) => z.string().trim().max(max);

export const ReviewSaveSchema = z.strictObject({
  fields: z.strictObject({
    name: z.string().trim().min(1, "Name is required").max(200),
    name_local: optionalText(200),
    // sites.category allows all of CATEGORIES (the extractor only emits a subset).
    type: z.enum(CATEGORIES),
    era: optionalText(120),
    crafts: z.array(z.string().trim().min(1).max(80)).max(12),
    place_name: optionalText(300),
    region: optionalText(120),
    state: optionalText(120),
    district: optionalText(120),
    summary_en: optionalText(4_000),
    text_en: optionalText(200_000),
    folklore_notes: optionalText(4_000),
  }),
  /** null = the reviewer has not placed a pin. A non-null value is stored as a manual pin if it moved. */
  location: z
    .strictObject({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .nullable(),
  /** Uncertain fields still flagged after the reviewer's clicks. The server can only clear flags, never add them. */
  uncertain_fields: z.array(z.enum(EXTRACT_FIELDS)).max(EXTRACT_FIELDS.length),
  publish: z.boolean(),
});

export type ReviewSaveInput = z.infer<typeof ReviewSaveSchema>;
