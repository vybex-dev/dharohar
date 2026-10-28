// lib/geocoding.ts
import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pointEwkt } from "@/lib/stages/util";

export type GeoPoint = { lat: number; lng: number };

export type GeocodeResult = {
  point: GeoPoint | null;
  confidence: number | null; // 0.3-0.85 when point is set, else null
  displayName: string | null;
};

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

export function geocodeConfig() {
  return {
    // Nominatim's policy caps this at 1 req/s; 1100ms leaves a small safety margin.
    minGapMs: envInt("GEOCODE_MIN_GAP_MS", 1100, 1000),
    timeoutMs: envInt("GEOCODE_TIMEOUT_MS", 10_000, 1000),
  };
}

export function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

/* =========================================================================
 * Rate limiting: 1 request/second, serialized across concurrent invocations.
 * See sql/007_nominatim_rate_limit.sql for why an in-process timestamp alone
 * isn't enough on Vercel (different serverless instances share no memory).
 * ========================================================================= */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let lastCallAt = 0; // best-effort, per warm server instance
let warnedNoRpc = false;

async function waitForNominatimSlot(
  db: SupabaseClient,
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
        "[geocoding] reserve_nominatim_slot RPC unavailable (run sql/007_nominatim_rate_limit.sql). " +
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

async function readCache(
  db: SupabaseClient,
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
  db: SupabaseClient,
  norm: string,
  point: GeoPoint | null,
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

/**
 * Cache-first geocoding of a free-form place string. Used by:
 *  - lib/stages/geocode.ts  (place_name extracted from an upload)
 *  - app/api/search/route.ts (a place a visitor typed into search)
 * Only calls Nominatim (rate-limited — see waitForNominatimSlot) on a cache miss.
 */
export async function geocodeQuery(
  db: SupabaseClient,
  rawQuery: string,
  cfg: ReturnType<typeof geocodeConfig> = geocodeConfig(),
): Promise<GeocodeResult> {
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
