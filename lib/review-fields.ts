// lib/review-fields.ts
// Client-safe: types and pure helpers shared by the review page (client) and
// lib/review.ts (server). No zod and no server-only imports here.
import type { ExtractField } from "@/lib/extract-schema";

/** One form value per extracted field. `null` in the database is "" here. */
export type ReviewFields = {
  [K in ExtractField]: K extends "crafts" ? string[] : string;
};

/** Record<ExtractField, …>: adding a field to EXTRACT_FIELDS is a compile error until it is listed here. */
export const FIELD_META: Record<ExtractField, { label: string; help?: string }> =
  {
    name: { label: "Name (English)" },
    name_local: { label: "Name in original script" },
    type: { label: "Type" },
    era: { label: "Era / period", help: "As stated, e.g. “11th century CE”" },
    crafts: {
      label: "Crafts & techniques",
      help: "Comma-separated, up to 12",
    },
    place_name: {
      label: "Place name",
      help: "Used for geocoding; changing it does NOT move the pin",
    },
    region: { label: "Region" },
    state: { label: "State" },
    district: { label: "District" },
    summary_en: { label: "Summary (English)" },
    text_en: { label: "English translation of the full text" },
    folklore_notes: { label: "Folklore & oral tradition" },
  };

export const ALL_FIELDS = Object.keys(FIELD_META) as ExtractField[];

export type LatLng = { lat: number; lng: number };

/* ------------------------------------------------------------ comparison */

export function normalizeCrafts(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (t !== "" && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, 12);
}

export function parseCrafts(text: string): string[] {
  return normalizeCrafts(text.split(/[,;\n]/));
}

export function normalizeFields(f: ReviewFields): ReviewFields {
  return {
    name: f.name.trim(),
    name_local: f.name_local.trim(),
    type: f.type.trim(),
    era: f.era.trim(),
    crafts: normalizeCrafts(f.crafts),
    place_name: f.place_name.trim(),
    region: f.region.trim(),
    state: f.state.trim(),
    district: f.district.trim(),
    summary_en: f.summary_en.trim(),
    text_en: f.text_en.trim(),
    folklore_notes: f.folklore_notes.trim(),
  };
}

/** True when the two forms differ in field `k`, ignoring surrounding whitespace. */
export function fieldChanged(
  k: ExtractField,
  a: ReviewFields,
  b: ReviewFields,
): boolean {
  if (k === "crafts") {
    return (
      JSON.stringify(normalizeCrafts(a.crafts)) !==
      JSON.stringify(normalizeCrafts(b.crafts))
    );
  }
  return a[k].trim() !== b[k].trim();
}

export function sameLocation(
  a: LatLng | null,
  b: LatLng | null,
  epsilon = 1e-6,
): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.lat - b.lat) <= epsilon && Math.abs(a.lng - b.lng) <= epsilon;
}

/* ------------------------------------------------------------ data shapes */

export type JobState = {
  id: string;
  stage: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  error: string | null;
  site_id: string | null;
};

export type AssetView = {
  id: string;
  kind: "photo" | "scan";
  mimeType: string | null;
  filename: string | null;
  /** Short-lived signed URL (the bucket is private). Null if signing failed or the job is not ready. */
  signedUrl: string | null;
  language: string | null;
  ocrText: string | null;
  ocrConfidence: number | null;
  /** What the contributor typed on the upload form. */
  uploaderTitle: string | null;
  uploaderNotes: string | null;
};

export type SiteState = {
  id: string;
  slug: string;
  status: "draft" | "published" | "archived";
  humanCorrected: boolean;
  humanCorrectedAt: string | null;
  needsManualLocation: boolean;
  locationSource: "exif" | "geocoded" | "manual" | "seed" | null;
  locationConfidence: number | null;
  lat: number | null;
  lng: number | null;
  fieldConfidence: Record<string, number>;
};

export type PendingReview = { ready: false; job: JobState; asset: AssetView };

export type ReadyReview = {
  ready: true;
  job: JobState;
  asset: AssetView;
  site: SiteState;
  fields: ReviewFields;
  /** Fields the extractor was unsure about and nobody has verified yet. */
  uncertain: ExtractField[];
};

export type ReviewData = PendingReview | ReadyReview;

/** Response body of POST /api/review/[jobId]. */
export type ReviewSaveResponse =
  | {
      ok: true;
      review: ReadyReview;
      /** Set when the corrections were saved but re-indexing failed; the site was NOT published. */
      indexError: string | null;
      reembedded: number;
    }
  | { ok: false; error: string };
