// lib/stages/geocode.ts
import "server-only";
import { z } from "zod";
import type { StageContext, StageHandler } from "./types";
import { pointEwkt } from "./util";

/* =========================================================================
 * Config (defaults are my own design choices, not provider limits — VERIFY
 * Nominatim's current usage policy at https://operations.osmfoundation.org/policies/nominatim/)
 * ========================================================================= */

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function config() {
  return {
    // Nominatim's policy caps this at 1 req/s; 1100ms leaves a small safety margin.
    minGapMs: envInt("GEOCODE_MIN_GAP_MS", 1100, 1000),
    timeoutMs: envInt("GEOCODE_TIMEOUT_MS", 10_000, 1000),
  };
}

const EXIF_CONFIDENCE = 0.95;

/* =========================================================================
 * Types
 * ========================================================================= */

type Point = { lat: number; lng: number };

type SiteRow = {
  address_text: string | null;
  district: string | null;
  region: string | null;
  state: string | null;
  location_source: string | null;
};

type GeocodeLabel = "exif" | "geocoded" | "manual_needed";

function asPoint(v: unknown): Point | null {
  if (!v || typeof v !== "object") return null;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  return typeof lat === "number" && typeof lng === "number"
    ? { lat, lng }
    : null;
}

/* =========================================================================
 * Building the Nominatim query from extracted fields
 * ========================================================================= */

/** address_text (the extract stage's `place_name`), then district, region, state — de-duplicated, with ", India" appended unless already present. */
function buildQuery(site: SiteRow): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [
    site.address_text,
    site.district,
    site.region,
    site.state,
  ]) {
    const v = raw?.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(v);
  }
  if (parts.length === 0) return null;
  let q = parts.join(", ");
  if (!/\bindia\b/i.test(q)) q += ", India";
  return q;
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

/* =========================================================================
 * Rate limiting: 1 request/second, serialized across concurrent invocations
 * ========================================================================= */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Per-warm-instance guard. Cheap, but alone insufficient on serverless (see below).
let lastCallAt = 0;
let warnedNoRpc = false;

/**
 * Waits until it is safe to call Nominatim. Uses an in-process timestamp first
 * (free, same-instance), then reserves a slot via the `reserve_nominatim_slot`
 * Postgres function (sql/007_nominatim_rate_limit.sql), which serializes calls
 * across different Vercel function instances using a row lock — a plain JS
 * variable cannot do this because each instance has its own memory.
 */
async function waitForNominatimSlot(
  db: StageContext["db"],
  minGapMs: number,
): Promise<void> {
  const localWait = lastCallAt + minGapMs - Date.now();
  if (localWait > 0) await sleep(localWait);

  try {
    const { data, error } = await db.rpc("reserve_nominatim_slot", {
      p_min_gap_ms: minGapMs,
    });
    if (error) throw error;
    if (typeof data === "string") {
      const until = new Date(data).getTime();
      const wait = until - Date.now();
      if (wait > 0) await sleep(wait);
    }
  } catch {
    if (!warnedNoRpc) {
      console.warn(
        "[geocode] reserve_nominatim_slot RPC unavailable (run sql/007_nominatim_rate_limit.sql). " +
          "Falling back to a per-instance rate limit only, which does NOT guarantee 1 req/s under concurrent requests.",
      );
      warnedNoRpc = true;
    }
  }
  lastCallAt = Date.now();
}

/* =========================================================================
 * Nominatim call
 * ========================================================================= */

const NominatimResultSchema = z.object({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  importance: z.number().optional(),
});
const NominatimResultsSchema = z.array(NominatimResultSchema);
type NominatimResult = z.infer<typeof NominatimResultSchema>;

async function callNominatim(
  query: string,
  timeoutMs: number,
): Promise<NominatimResult | null> {
  const baseUrl = (
    process.env.NOMINATIM_BASE_URL?.trim() ||
    "https://nominatim.openstreetmap.org"
  ).replace(/\/+$/, "");
  const userAgent = process.env.NOMINATIM_USER_AGENT?.trim();
  if (!userAgent) {
    throw new Error(
      "NOMINATIM_USER_AGENT is not set. Nominatim's usage policy requires an identifying " +
        'User-Agent (e.g. "Dharohar/0.1 (you@example.com)"); set it in your env.',
    );
  }
  // Optional, e.g. "in". Leave unset to search worldwide. VERIFY this is still
  // the correct param name in Nominatim's docs if you change providers.
  const countryCodes = process.env.NOMINATIM_COUNTRY_CODES?.trim();

  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    limit: "1",
    addressdetails: "0",
  });
  if (countryCodes) params.set("countrycodes", countryCodes);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/search?${params.toString()}`, {
      headers: { "User-Agent": userAgent, "Accept-Language": "en" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(
      `Nominatim request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Nominatim returned HTTP ${res.status}: ${body}`);
  }

  const json = await res.json().catch(() => null);
  const parsed = NominatimResultsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Unexpected Nominatim response shape");
  }
  return parsed.data[0] ?? null;
}

/** Nominatim's own relevance score (0–1, often absent) scaled into a 0.3–0.85 confidence band. */
function geocodedConfidence(importance: number | undefined): number {
  const imp =
    typeof importance === "number" && Number.isFinite(importance)
      ? importance
      : 0.3;
  return Number(Math.min(0.85, Math.max(0.3, 0.3 + imp * 0.6)).toFixed(3));
}

/* =========================================================================
 * geocode_cache read/write
 * ========================================================================= */

type CacheRow = {
  found: boolean;
  lat: number | null;
  lon: number | null;
  display_name: string | null;
  raw: unknown;
};

type GeocodeOutcome = {
  point: Point | null;
  confidence: number | null;
  displayName: string | null;
};

async function readCache(
  db: StageContext["db"],
  norm: string,
): Promise<CacheRow | null> {
  const { data, error } = await db
    .from("geocode_cache")
    .select("found, lat, lon, display_name, raw")
    .eq("query_norm", norm)
    .maybeSingle();
  if (error) throw new Error(`Could not read geocode cache: ${error.message}`);
  return (data as CacheRow | null) ?? null;
}

async function writeCache(
  db: StageContext["db"],
  norm: string,
  point: Point | null,
  displayName: string | null,
  raw: unknown,
): Promise<void> {
  const { error } = await db.from("geocode_cache").upsert(
    {
      query_norm: norm,
      found: point !== null,
      lat: point?.lat ?? null,
      lon: point?.lng ?? null,
      location: point ? pointEwkt(point.lat, point.lng) : null,
      display_name: displayName,
      raw,
      provider: "nominatim",
    },
    { onConflict: "query_norm" },
  );
  if (error)
    throw new Error(`Could not save geocode cache entry: ${error.message}`);
}

/** Cache-first lookup; only calls Nominatim (and only once per unique query) on a miss. */
async function geocodeQuery(
  db: StageContext["db"],
  rawQuery: string,
  cfg: ReturnType<typeof config>,
): Promise<GeocodeOutcome> {
  const norm = normalizeQuery(rawQuery);

  const cached = await readCache(db, norm);
  if (cached) {
    const point =
      cached.found &&
      typeof cached.lat === "number" &&
      typeof cached.lon === "number"
        ? { lat: cached.lat, lng: cached.lon }
        : null;
    const importance =
      cached.raw && typeof cached.raw === "object" && "importance" in cached.raw
        ? Number((cached.raw as { importance?: unknown }).importance)
        : undefined;
    return {
      point,
      confidence: point ? geocodedConfidence(importance) : null,
      displayName: cached.display_name,
    };
  }

  await waitForNominatimSlot(db, cfg.minGapMs);
  const result = await callNominatim(rawQuery, cfg.timeoutMs);

  if (!result) {
    await writeCache(db, norm, null, null, null);
    return { point: null, confidence: null, displayName: null };
  }

  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(
      `Nominatim returned a non-numeric coordinate for "${rawQuery}"`,
    );
  }
  const point = { lat, lng: lon };
  await writeCache(db, norm, point, result.display_name, result);
  return {
    point,
    confidence: geocodedConfidence(result.importance),
    displayName: result.display_name,
  };
}

/* =========================================================================
 * Pipeline stage
 * ========================================================================= */

export const geocodeStage: StageHandler = async ({ db, job, asset }) => {
  const cfg = config();
  const siteId = job.site_id ?? asset.site_id;
  if (!siteId) {
    throw new Error(
      "No site linked to this job. The extract stage must run first.",
    );
  }

  const { data: siteData, error: siteErr } = await db
    .from("sites")
    .select("address_text, district, region, state, location_source")
    .eq("id", siteId)
    .maybeSingle();
  if (siteErr)
    throw new Error(`Could not read site for geocoding: ${siteErr.message}`);
  const site = siteData as SiteRow | null;

  // A human already placed this pin during review (location_source = 'manual').
  // Never clobber that on a re-run of this stage.
  if (site?.location_source === "manual") {
    return {
      output: {
        confidence: "manual" as const,
        skipped: "site has a manually placed pin",
      },
      provider: "internal",
    };
  }

  // 1. EXIF GPS, recorded by the `uploaded` stage
  const { data: run, error: runErr } = await db
    .from("job_stage_runs")
    .select("output")
    .eq("job_id", job.id)
    .eq("stage", "uploaded")
    .maybeSingle();
  if (runErr)
    throw new Error(`Could not read upload stage output: ${runErr.message}`);
  const exif = asPoint((run?.output as { exif?: unknown } | null)?.exif);

  let point: Point | null = null;
  let source: "exif" | "geocoded" | null = null;
  let confidence: number | null = null;
  let displayName: string | null = null;
  let query: string | null = null;

  if (exif) {
    // 1. EXIF GPS — highest confidence, no network call
    point = exif;
    source = "exif";
    confidence = EXIF_CONFIDENCE;
  } else {
    // 2. Nominatim on the extracted place_name + region (sites.address_text/district/region/state)
    query = site ? buildQuery(site) : null;
    if (query) {
      const r = await geocodeQuery(db, query, cfg);
      if (r.point) {
        point = r.point;
        source = "geocoded";
        confidence = r.confidence;
        displayName = r.displayName;
      }
    }
  }

  // 3. Neither worked: leave the point null and flag it for the review screen.
  const needsManual = point === null;

  const updates = {
    location: point ? pointEwkt(point.lat, point.lng) : null,
    location_source: source,
    location_confidence: confidence,
    needs_manual_location: needsManual,
  };

  const { error: siteUpdErr } = await db
    .from("sites")
    .update(updates)
    .eq("id", siteId);
  if (siteUpdErr)
    throw new Error(`Could not save site location: ${siteUpdErr.message}`);

  const { error: assetUpdErr } = await db
    .from("assets")
    .update(updates)
    .eq("id", asset.id);
  if (assetUpdErr)
    throw new Error(`Could not save asset location: ${assetUpdErr.message}`);

  const label: GeocodeLabel = source ?? "manual_needed";

  return {
    output: {
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      confidence: label, // "exif" | "geocoded" | "manual_needed"
      score: confidence, // 0-1, null when manual_needed
      source,
      query,
      display_name: displayName,
      needs_manual_location: needsManual,
    },
    provider:
      source === "exif"
        ? "exif"
        : source === "geocoded"
          ? "nominatim"
          : "internal",
  };
};
