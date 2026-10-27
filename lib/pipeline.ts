export const STAGES = [
  "uploaded",
  "ocr",
  "extract",
  "geocode",
  "embed",
  "published",
] as const;

export type Stage = (typeof STAGES)[number];
export type RunnableStage = Exclude<Stage, "published">;

export const STAGE_LABELS: Record<Stage, string> = {
  uploaded: "Verifying upload",
  ocr: "Reading text (OCR)",
  extract: "Extracting details",
  geocode: "Locating on the map",
  embed: "Indexing for search",
  published: "Published",
};

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

// Keep in sync with the bucket's file_size_limit (10 MB, set in sql/001_schema.sql).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Used by the stub geocoder when a file has no EXIF GPS.
export const DEFAULT_LOCATION = { lat: 23.0225, lng: 72.5714 } as const; // Ahmedabad

// Must match vector(768) in sql/001_schema.sql.
export const EMBEDDING_DIMENSIONS = 768;

/** Progress bar value: index of the NEXT stage to run, as a percentage. */
export function progressPercent(stage: Stage, status: string): number {
  if (stage === "published" && status === "done") return 100;
  return Math.round((STAGES.indexOf(stage) / (STAGES.length - 1)) * 100);
}
