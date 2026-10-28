// lib/review.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EXTRACT_FIELDS,
  isExtractField,
  type ExtractField,
} from "@/lib/extract-schema";
import { JOB_COLUMNS } from "@/lib/jobs";
import { callLLM, embeddingModelId } from "@/lib/llm";
import {
  fieldChanged,
  normalizeFields,
  sameLocation,
  type AssetView,
  type LatLng,
  type ReadyReview,
  type ReviewData,
  type ReviewFields,
  type SiteState,
} from "@/lib/review-fields";
import type { ReviewSaveInput } from "@/lib/review-schema";
import { splitText } from "@/lib/stages/extract";
import type { JobRow } from "@/lib/stages/types";
import { pointEwkt, sha256Hex } from "@/lib/stages/util";
import { getServerSupabase } from "@/lib/supabase-server";

const SIGNED_URL_TTL_SECONDS = 7200;

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

function dbFail(what: string, e: { message: string }): never {
  const hint = /human_corrected/.test(e.message)
    ? " (run sql/009_review_fields.sql in the Supabase SQL editor)"
    : "";
  throw new Error(`${what}: ${e.message}${hint}`);
}

/* =========================================================================
 * Row shapes
 * ========================================================================= */

type SiteRow = {
  id: string;
  slug: string;
  name_en: string;
  name_local: string | null;
  category: string;
  state: string | null;
  district: string | null;
  region: string | null;
  address_text: string | null;
  period: string | null;
  crafts: string[] | null;
  summary_en: string | null;
  folklore_notes: string | null;
  origin: string;
  status: "draft" | "published" | "archived";
  location_source: SiteState["locationSource"];
  location_confidence: number | null;
  needs_manual_location: boolean;
  uncertain_fields: string[] | null;
  field_confidence: Record<string, number> | null;
  human_corrected: boolean;
  human_corrected_at: string | null;
};

const SITE_COLUMNS =
  "id, slug, name_en, name_local, category, state, district, region, address_text, period, crafts, summary_en, folklore_notes, origin, status, location_source, location_confidence, needs_manual_location, uncertain_fields, field_confidence, human_corrected, human_corrected_at";

type AssetRow = {
  id: string;
  kind: "photo" | "scan" | "pano";
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
  original_filename: string | null;
  title: string | null;
  notes: string | null;
  language_detected: string | null;
  ocr_text: string | null;
  ocr_confidence: number | null;
  text_en: string | null;
};

const ASSET_COLUMNS =
  "id, kind, storage_bucket, storage_path, mime_type, original_filename, title, notes, language_detected, ocr_text, ocr_confidence, text_en";

/* =========================================================================
 * Loading
 * ========================================================================= */

async function loadJob(db: SupabaseClient, jobId: string) {
  const { data, error } = await db
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .maybeSingle();
  if (error) dbFail("Could not load job", error);
  return (data as JobRow | null) ?? null;
}

async function loadAsset(db: SupabaseClient, assetId: string) {
  const { data, error } = await db
    .from("assets")
    .select(ASSET_COLUMNS)
    .eq("id", assetId)
    .maybeSingle();
  if (error) dbFail("Could not load asset", error);
  if (!data) throw new Error("The job's asset no longer exists");
  return data as AssetRow;
}

async function loadSite(db: SupabaseClient, siteId: string) {
  const [siteRes, geoRes] = await Promise.all([
    db.from("sites").select(SITE_COLUMNS).eq("id", siteId).maybeSingle(),
    // PostgREST returns geography as hex EWKB; the view exposes plain numbers.
    db.from("sites_geo").select("lat, lng").eq("id", siteId).maybeSingle(),
  ]);
  if (siteRes.error) dbFail("Could not load site", siteRes.error);
  if (geoRes.error) dbFail("Could not load site location", geoRes.error);
  const site = (siteRes.data as SiteRow | null) ?? null;
  const geo = geoRes.data as { lat: number | null; lng: number | null } | null;
  const location: LatLng | null =
    geo?.lat != null && geo?.lng != null ? { lat: geo.lat, lng: geo.lng } : null;
  return { site, location };
}

function toFields(site: SiteRow, asset: AssetRow): ReviewFields {
  return {
    name: site.name_en ?? "",
    name_local: site.name_local ?? "",
    type: site.category,
    era: site.period ?? "",
    crafts: site.crafts ?? [],
    place_name: site.address_text ?? "",
    region: site.region ?? "",
    state: site.state ?? "",
    district: site.district ?? "",
    summary_en: site.summary_en ?? "",
    text_en: asset.text_en ?? "",
    folklore_notes: site.folklore_notes ?? "",
  };
}

async function signedUrlFor(
  db: SupabaseClient,
  asset: AssetRow,
): Promise<string | null> {
  const { data, error } = await db.storage
    .from(asset.storage_bucket)
    .createSignedUrl(asset.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error) {
    console.error("[review] could not sign the original:", error.message);
    return null; // the page still works, just without the image
  }
  return data.signedUrl;
}

function toAssetView(asset: AssetRow, signedUrl: string | null): AssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mime_type,
    filename: asset.original_filename,
    signedUrl,
    language: asset.language_detected,
    ocrText: asset.ocr_text?.trim() || null,
    ocrConfidence: asset.ocr_confidence,
    uploaderTitle: asset.title?.trim() || null,
    uploaderNotes: asset.notes?.trim() || null,
  };
}

/** Returns null when the job does not exist. Never returns draft data for a job that is still processing. */
export async function loadReview(jobId: string): Promise<ReviewData | null> {
  const db = getServerSupabase();
  const job = await loadJob(db, jobId);
  if (!job) return null;

  const jobState = {
    id: job.id,
    stage: job.stage,
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    error: job.error,
    site_id: job.site_id,
  };
  const asset = await loadAsset(db, job.asset_id);
  const finished =
    job.stage === "published" && job.status === "done" && job.site_id !== null;
  if (!finished || job.site_id === null) {
    return { ready: false, job: jobState, asset: toAssetView(asset, null) };
  }

  const [{ site, location }, signedUrl] = await Promise.all([
    loadSite(db, job.site_id),
    signedUrlFor(db, asset),
  ]);
  if (!site) throw new Error("The job's site no longer exists");

  return {
    ready: true,
    job: jobState,
    asset: toAssetView(asset, signedUrl),
    site: {
      id: site.id,
      slug: site.slug,
      status: site.status,
      humanCorrected: site.human_corrected,
      humanCorrectedAt: site.human_corrected_at,
      needsManualLocation: site.needs_manual_location,
      locationSource: site.location_source,
      locationConfidence: site.location_confidence,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      fieldConfidence: site.field_confidence ?? {},
    },
    fields: toFields(site, asset),
    uncertain: (site.uncertain_fields ?? []).filter(isExtractField),
  };
}

/* =========================================================================
 * Search chunks (must mirror lib/stages/extract.ts so a re-save of unchanged
 * data produces identical hashes and therefore no re-embedding)
 * ========================================================================= */

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Chunk 0 = headline + summary, 1.. = pieces of the English text. KEEP IN SYNC with extractStage. */
export function buildChunkTexts(f: ReviewFields): string[] {
  const searchChunkChars = envInt("EXTRACT_SEARCH_CHUNK_CHARS", 1000, 300);
  const maxSearchChunks = envInt("EXTRACT_MAX_SEARCH_CHUNKS", 40, 1);
  const headline = [
    f.name,
    f.type !== "other" ? f.type : null,
    f.place_name || null,
    f.era || null,
  ]
    .filter((x): x is string => !!x)
    .join(" | ");
  const body = splitText(f.text_en, searchChunkChars).slice(
    0,
    maxSearchChunks - 1,
  );
  return [`${headline}\n${f.summary_en}`, ...body];
}

type ChunkRow = {
  id: string;
  chunk_index: number;
  text_en: string;
  content_hash: string | null;
  embedding_model: string | null;
};

/**
 * Brings doc_chunks in line with the saved text and embeds whatever is not yet
 * embedded with the current model. Idempotent: unchanged chunks keep their
 * vectors; a failed run is healed by simply running it again.
 * Returns how many chunks were embedded.
 */
async function syncChunks(
  db: SupabaseClient,
  asset: AssetRow,
  siteId: string,
  f: ReviewFields,
): Promise<number> {
  const chunkTexts = buildChunkTexts(f);

  const { data: existing, error: exErr } = await db
    .from("doc_chunks")
    .select("id, chunk_index, text_en, content_hash, embedding_model")
    .eq("asset_id", asset.id);
  if (exErr) dbFail("Could not read existing chunks", exErr);
  const hashByIndex = new Map(
    ((existing ?? []) as ChunkRow[]).map((r) => [r.chunk_index, r.content_hash]),
  );

  const changed = chunkTexts
    .map((text, i) => ({ text, i, hash: sha256Hex(text) }))
    .filter((c) => hashByIndex.get(c.i) !== c.hash)
    .map((c) => ({
      site_id: siteId,
      asset_id: asset.id,
      chunk_index: c.i,
      text_en: c.text,
      text_original: null,
      language: c.i === 0 ? "en" : asset.language_detected,
      ocr_confidence: c.i === 0 ? null : asset.ocr_confidence,
      content_hash: c.hash,
      embedding: null, // the old vector describes the old text
      embedding_model: null,
    }));
  if (changed.length > 0) {
    const { error } = await db
      .from("doc_chunks")
      .upsert(changed, { onConflict: "asset_id,chunk_index" });
    if (error) dbFail("Could not save chunks", error);
  }
  const { error: staleErr } = await db
    .from("doc_chunks")
    .delete()
    .eq("asset_id", asset.id)
    .gte("chunk_index", chunkTexts.length);
  if (staleErr) dbFail("Could not remove stale chunks", staleErr);

  // Same rule as the embed stage: anything not embedded with the current model is pending.
  const model = embeddingModelId();
  const { data: rows, error: rowsErr } = await db
    .from("doc_chunks")
    .select("id, chunk_index, text_en, content_hash, embedding_model")
    .eq("asset_id", asset.id)
    .order("chunk_index", { ascending: true });
  if (rowsErr) dbFail("Could not re-read chunks", rowsErr);
  const pending = ((rows ?? []) as ChunkRow[]).filter(
    (r) => r.embedding_model !== model,
  );
  if (pending.length === 0) return 0;

  const r = await callLLM("embed", {
    texts: pending.map((p) => p.text_en),
    purpose: "document",
  });
  if (r.output.vectors.length !== pending.length) {
    throw new Error(
      `Expected ${pending.length} vectors, got ${r.output.vectors.length}`,
    );
  }
  for (let i = 0; i < pending.length; i += 10) {
    const group = pending.slice(i, i + 10);
    const results = await Promise.all(
      group.map((row, j) =>
        db
          .from("doc_chunks")
          .update({
            embedding: JSON.stringify(r.output.vectors[i + j]),
            embedding_model: r.model,
          })
          .eq("id", row.id),
      ),
    );
    const bad = results.find((x) => x.error);
    if (bad?.error) dbFail("Could not save an embedding", bad.error);
  }
  return pending.length;
}

/* =========================================================================
 * Saving
 * ========================================================================= */

/** Form field -> sites column. text_en lives on assets, so it is not listed. */
const SITE_COLUMN: Partial<Record<ExtractField, string>> = {
  name: "name_en",
  name_local: "name_local",
  type: "category",
  era: "period",
  crafts: "crafts",
  place_name: "address_text",
  region: "region",
  state: "state",
  district: "district",
  summary_en: "summary_en",
  folklore_notes: "folklore_notes",
};

function dbValue(k: ExtractField, f: ReviewFields): unknown {
  if (k === "crafts" || k === "name" || k === "type") return f[k];
  return f[k] === "" ? null : f[k];
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}

export type SaveResult = {
  review: ReadyReview;
  /** Non-null when corrections were saved but search indexing failed (and publishing was skipped). */
  indexError: string | null;
  reembedded: number;
};

/**
 * Saves the reviewer's corrections and optionally publishes.
 *
 * Idempotent: it diffs the request against what is stored, writes only the
 * difference, and re-embeds only chunks whose text changed. Posting the same
 * request twice leaves the database in the same state.
 * Supabase has no multi-statement transactions over REST, so the writes are
 * ordered so that a half-finished run is safe to repeat: fields first, then
 * chunks and embeddings, and the status flip to 'published' last.
 */
export async function saveReview(
  jobId: string,
  input: ReviewSaveInput,
): Promise<SaveResult> {
  const db = getServerSupabase();

  const job = await loadJob(db, jobId);
  if (!job) throw new ReviewError("Job not found", 404);
  if (
    !(job.stage === "published" && job.status === "done") ||
    job.site_id === null
  ) {
    throw new ReviewError(
      "This job is still processing. Wait until it finishes, then review it.",
      409,
    );
  }
  const siteId = job.site_id;

  const asset = await loadAsset(db, job.asset_id);
  const { site, location: currentLocation } = await loadSite(db, siteId);
  if (!site) throw new ReviewError("Site not found", 404);
  if (site.status === "archived") {
    throw new ReviewError("This record is archived and cannot be edited here.", 409);
  }

  /* ---- what changed ---- */
  const current = normalizeFields(toFields(site, asset));
  const next = normalizeFields(input.fields);
  const changed = EXTRACT_FIELDS.filter((k) => fieldChanged(k, current, next));

  const requestedPin: LatLng | null = input.location
    ? { lat: round6(input.location.lat), lng: round6(input.location.lng) }
    : null;
  // The form cannot remove a pin, so null means "leave it as it is".
  const finalLocation = requestedPin ?? currentLocation;
  const locationChanged =
    requestedPin !== null && !sameLocation(requestedPin, currentLocation);

  if (input.publish && finalLocation === null) {
    // Same rule as the embed stage: a published site without a location never shows on the map.
    throw new ReviewError(
      "Place a pin on the map before publishing. Nothing was saved.",
      422,
    );
  }

  // A reviewer can only clear "uncertain" flags. Editing a field counts as verifying it.
  const prevUncertain = (site.uncertain_fields ?? []).filter(isExtractField);
  const requested = new Set<ExtractField>(input.uncertain_fields);
  const nextUncertain = EXTRACT_FIELDS.filter(
    (k) => prevUncertain.includes(k) && requested.has(k) && !changed.includes(k),
  );
  const uncertainChanged =
    nextUncertain.length !== prevUncertain.length ||
    nextUncertain.some((k) => !prevUncertain.includes(k));
  const verifiedNow = EXTRACT_FIELDS.filter(
    (k) => changed.includes(k) || (prevUncertain.includes(k) && !nextUncertain.includes(k)),
  );

  const touched =
    changed.length > 0 || locationChanged || uncertainChanged || input.publish;

  /* ---- 1. site row ---- */
  const siteUpdate: Record<string, unknown> = {};
  for (const k of changed) {
    const col = SITE_COLUMN[k];
    if (col) siteUpdate[col] = dbValue(k, next);
  }
  if (
    site.origin === "upload" &&
    (changed.includes("type") || changed.includes("crafts"))
  ) {
    // Same recipe as extractStage.
    siteUpdate.tags = [
      ...new Set([
        ...(next.type !== "other" ? [next.type] : []),
        ...next.crafts.map((c) => c.toLowerCase()),
        "upload",
      ]),
    ].slice(0, 15);
  }
  if (locationChanged && requestedPin) {
    Object.assign(siteUpdate, {
      location: pointEwkt(requestedPin.lat, requestedPin.lng),
      location_source: "manual", // geocode.ts never overwrites a manual pin
      location_confidence: 1,
      needs_manual_location: false,
    });
  } else if (site.needs_manual_location && finalLocation !== null) {
    siteUpdate.needs_manual_location = false;
  }
  if (uncertainChanged) siteUpdate.uncertain_fields = nextUncertain;
  if (verifiedNow.length > 0) {
    const conf = { ...(site.field_confidence ?? {}) };
    for (const k of verifiedNow) conf[k] = 1;
    siteUpdate.field_confidence = conf;
  }
  if (touched && !site.human_corrected) {
    siteUpdate.human_corrected = true;
    siteUpdate.human_corrected_at = new Date().toISOString();
  }
  if (Object.keys(siteUpdate).length > 0) {
    const { error } = await db.from("sites").update(siteUpdate).eq("id", siteId);
    if (error) dbFail("Could not save the corrections", error);
  }

  /* ---- 2. asset row (English text + mirrored location, as geocode.ts does) ---- */
  const assetUpdate: Record<string, unknown> = {};
  if (changed.includes("text_en")) assetUpdate.text_en = next.text_en || null;
  if (locationChanged && requestedPin) {
    Object.assign(assetUpdate, {
      location: pointEwkt(requestedPin.lat, requestedPin.lng),
      location_source: "manual",
      location_confidence: 1,
      needs_manual_location: false,
    });
  }
  if (Object.keys(assetUpdate).length > 0) {
    const { error } = await db.from("assets").update(assetUpdate).eq("id", asset.id);
    if (error) dbFail("Could not save the English text", error);
  }

  /* ---- 3. search chunks + embeddings, then 4. publish ---- */
  let reembedded = 0;
  let indexError: string | null = null;
  try {
    reembedded = await syncChunks(db, asset, siteId, next);
  } catch (e) {
    indexError = e instanceof Error ? e.message : String(e);
    console.error("[review] re-indexing failed:", e);
  }

  if (input.publish && indexError === null && site.status !== "published") {
    const { error } = await db
      .from("sites")
      .update({ status: "published" })
      .eq("id", siteId);
    if (error) dbFail("Saved, but could not publish", error);
  }

  const review = await loadReview(jobId);
  if (!review || !review.ready) throw new Error("Could not reload the saved record");
  return { review, indexError, reembedded };
}
