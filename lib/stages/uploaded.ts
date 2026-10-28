import { MAX_UPLOAD_BYTES } from "@/lib/pipeline";
import type { StageHandler } from "./types";
import { pointEwkt, sha256Hex } from "./util";

type GpsFn = (
  input: Uint8Array,
) => Promise<{ latitude: number; longitude: number } | undefined>;
type ExifrModule = { gps?: GpsFn; default?: { gps?: GpsFn } };

async function readGps(
  bytes: Uint8Array,
): Promise<{ lat: number; lng: number } | null> {
  try {
    // Dynamic import + both export shapes, so ESM/CJS interop can't break the build.
    const mod = (await import("exifr")) as unknown as ExifrModule;
    const gps = mod.gps ?? mod.default?.gps;
    if (!gps) return null;
    const r = await gps(bytes);
    if (r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
      return { lat: r.latitude, lng: r.longitude };
    }
    return null;
  } catch {
    return null; // Unreadable EXIF must never fail the pipeline.
  }
}

export const uploadedStage: StageHandler = async ({ db, asset }) => {
  const { data: blob, error } = await db.storage
    .from(asset.storage_bucket)
    .download(asset.storage_path);

  if (error || !blob) {
    throw new Error(
      `File not found in storage at "${asset.storage_path}". ` +
        `Did the browser upload finish? (${error?.message ?? "no data"})`,
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Uploaded file is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Uploaded file is ${bytes.byteLength} bytes, over the limit`,
    );
  }

  const hash = sha256Hex(bytes);
  const isImage = asset.mime_type?.startsWith("image/") ?? false;
  const gps = isImage ? await readGps(bytes) : null;

  // Detect 360-degree equirectangular panoramas (standard 2:1 aspect ratio, e.g. 4000x2000)
  let detectedKind: "photo" | "scan" | "pano" = asset.kind;
  let dimensions: { width: number; height: number; ratio: number } | null = null;
  if (isImage && asset.kind !== "scan") {
    try {
      const sharpMod = await import("sharp");
      const sharpFn = sharpMod.default ?? sharpMod;
      const meta = await sharpFn(bytes).metadata();
      if (meta.width && meta.height) {
        const ratio = meta.width / meta.height;
        dimensions = {
          width: meta.width,
          height: meta.height,
          ratio: Math.round(ratio * 100) / 100,
        };
        // Equirectangular projection is strictly 2:1 (360° x 180°). Allow small ±4% margin of error
        if (Math.abs(ratio - 2.0) <= 0.08 && meta.width >= 800) {
          detectedKind = "pano";
        }
      }
    } catch (err) {
      // Image metadata failure should not abort upload stage
      console.warn("[uploadedStage] Image dimension check skipped:", err);
    }
  }

  const { error: updErr } = await db
    .from("assets")
    .update({
      content_hash: hash,
      size_bytes: bytes.byteLength,
      kind: detectedKind,
      exif_location: gps ? pointEwkt(gps.lat, gps.lng) : null,
    })
    .eq("id", asset.id);
  if (updErr)
    throw new Error(`Could not save asset metadata: ${updErr.message}`);

  return {
    output: {
      contentHash: hash,
      sizeBytes: bytes.byteLength,
      exif: gps,
      dimensions,
      kind: detectedKind,
    },
    provider: "internal",
  };
};
