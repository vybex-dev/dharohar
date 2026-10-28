// lib/stages/geocode.ts
import "server-only";
import { geocodeConfig, geocodeQuery, type GeoPoint } from "@/lib/geocoding";
import type { StageHandler } from "./types";
import { pointEwkt } from "./util";

const EXIF_CONFIDENCE = 0.95;

type SiteRow = {
  address_text: string | null;
  district: string | null;
  region: string | null;
  state: string | null;
  location_source: string | null;
};

type GeocodeLabel = "exif" | "geocoded" | "manual_needed";

function asPoint(v: unknown): GeoPoint | null {
  if (!v || typeof v !== "object") return null;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  return typeof lat === "number" && typeof lng === "number"
    ? { lat, lng }
    : null;
}

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

export const geocodeStage: StageHandler = async ({ db, job, asset }) => {
  const cfg = geocodeConfig();
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
  // Never clobber that on a re-run. Also clear needs_manual_location in case it
  // was left true by an earlier failed run — embed.ts's publish gate reads it.
  if (site?.location_source === "manual") {
    const { error: clearErr } = await db
      .from("sites")
      .update({ needs_manual_location: false })
      .eq("id", siteId)
      .eq("needs_manual_location", true);
    if (clearErr)
      throw new Error(
        `Could not clear the manual-location flag: ${clearErr.message}`,
      );
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

  let point: GeoPoint | null = null;
  let source: "exif" | "geocoded" | null = null;
  let confidence: number | null = null;
  let displayName: string | null = null;
  let query: string | null = null;

  if (exif) {
    point = exif;
    source = "exif";
    confidence = EXIF_CONFIDENCE;
  } else {
    // 2. Nominatim on the extracted place_name + region
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
      confidence: label,
      score: confidence,
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
