import { DEFAULT_LOCATION } from "@/lib/pipeline";
import type { StageHandler } from "./types";
import { pointEwkt, sha256Hex, unitFromHex } from "./util";

type Point = { lat: number; lng: number };

function asPoint(v: unknown): Point | null {
  if (!v || typeof v !== "object") return null;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  return typeof lat === "number" && typeof lng === "number"
    ? { lat, lng }
    : null;
}

export const geocodeStage: StageHandler = async ({ db, job, asset }) => {
  const siteId = job.site_id ?? asset.site_id;
  if (!siteId)
    throw new Error(
      "No site linked to this job. The extract stage must run first.",
    );

  // EXIF point recorded by the `uploaded` stage
  const { data: run, error: runErr } = await db
    .from("job_stage_runs")
    .select("output")
    .eq("job_id", job.id)
    .eq("stage", "uploaded")
    .maybeSingle();
  if (runErr)
    throw new Error(`Could not read upload stage output: ${runErr.message}`);
  const exif = asPoint((run?.output as { exif?: unknown } | null)?.exif);

  let point: Point;
  let source: "exif" | "geocoded";
  let confidence: number;

  if (exif) {
    point = exif;
    source = "exif";
    confidence = 0.95;
  } else {
    // Fake: default city plus a deterministic offset of up to about 4 km.
    const seed = asset.content_hash ?? sha256Hex(asset.id);
    point = {
      lat: DEFAULT_LOCATION.lat + (unitFromHex(seed, 1) - 0.5) * 0.08,
      lng: DEFAULT_LOCATION.lng + (unitFromHex(seed, 2) - 0.5) * 0.08,
    };
    source = "geocoded";
    confidence = 0.1;
  }

  const { error } = await db
    .from("sites")
    .update({
      location: pointEwkt(point.lat, point.lng),
      location_source: source,
      location_confidence: confidence,
    })
    .eq("id", siteId);
  if (error) throw new Error(`Could not save location: ${error.message}`);

  return {
    output: { ...point, source, confidence, stub: source !== "exif" },
    provider: source === "exif" ? "exif" : "stub",
  };
};
