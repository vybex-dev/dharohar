import type { StageHandler } from "./types";
import { fakeEmbedding, sha256Hex } from "./util";

export const embedStage: StageHandler = async ({ db, job, asset }) => {
  const siteId = job.site_id ?? asset.site_id;
  if (!siteId)
    throw new Error(
      "No site linked to this job. The extract stage must run first.",
    );

  // Temporary fallback chain until the real extract stage supplies translated text_en.
  const text =
    asset.text_en?.trim() ||
    asset.ocr_text?.trim() ||
    asset.title?.trim() ||
    `Upload ${asset.id.slice(0, 8)}`;

  const embedding = fakeEmbedding(asset.content_hash ?? sha256Hex(asset.id));

  // unique(asset_id, chunk_index) makes this an idempotent upsert.
  const { error: chunkErr } = await db.from("doc_chunks").upsert(
    {
      site_id: siteId,
      asset_id: asset.id,
      chunk_index: 0,
      text_en: text,
      text_original: asset.ocr_text,
      language: asset.language_detected,
      ocr_confidence: asset.ocr_confidence,
      content_hash: sha256Hex(text),
      embedding: JSON.stringify(embedding), // pgvector accepts '[0.1,0.2,...]'
      embedding_model: "stub",
    },
    { onConflict: "asset_id,chunk_index" },
  );
  if (chunkErr) throw new Error(`Could not save chunk: ${chunkErr.message}`);

  // Stub pipeline auto-publishes. A real review step will gate this later.
  const { error: pubErr } = await db
    .from("sites")
    .update({ status: "published" })
    .eq("id", siteId);
  if (pubErr) throw new Error(`Could not publish site: ${pubErr.message}`);

  return {
    output: { siteId, dims: embedding.length, stub: true },
    provider: "stub",
    model: "stub",
  };
};
