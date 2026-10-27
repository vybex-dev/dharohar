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
  const gps = asset.mime_type?.startsWith("image/")
    ? await readGps(bytes)
    : null;

  const { error: updErr } = await db
    .from("assets")
    .update({
      content_hash: hash,
      size_bytes: bytes.byteLength,
      exif_location: gps ? pointEwkt(gps.lat, gps.lng) : null,
    })
    .eq("id", asset.id);
  if (updErr)
    throw new Error(`Could not save asset metadata: ${updErr.message}`);

  return {
    output: { contentHash: hash, sizeBytes: bytes.byteLength, exif: gps },
    provider: "internal",
  };
};
