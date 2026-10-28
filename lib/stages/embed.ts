// lib/stages/embed.ts
import "server-only";
import { callLLM, embeddingModelId } from "@/lib/llm";
import type { StageHandler } from "./types";

type ChunkRow = {
  id: string;
  chunk_index: number;
  text_en: string;
  embedding_model: string | null;
};

export const embedStage: StageHandler = async ({ db, job, asset }) => {
  const siteId = job.site_id ?? asset.site_id;
  if (!siteId)
    throw new Error(
      "No site linked to this job. The extract stage must run first.",
    );

  // chunk_index 0 is "headline | type | place_name | era\n<summary_en>" (built in
  // extract.ts), so embedding every doc_chunk already embeds the site summary —
  // there's no separate summary embedding column to maintain.
  const { data, error } = await db
    .from("doc_chunks")
    .select("id, chunk_index, text_en, embedding_model")
    .eq("asset_id", asset.id)
    .order("chunk_index", { ascending: true });
  if (error) throw new Error(`Could not read chunks: ${error.message}`);
  const rows = (data ?? []) as ChunkRow[];
  if (rows.length === 0)
    throw new Error(
      "No chunks to embed. The extract stage must write them first.",
    );

  const model = embeddingModelId(); // reads GEMINI_MODEL_EMBED; throws if unset

  // Idempotent: a chunk whose embedding_model already matches the current
  // model is left untouched. Re-running this stage (retry, or a re-run of
  // the whole job) only ever embeds what's missing or stale.
  const pending = rows.filter((r) => r.embedding_model !== model);

  let usedModel = model;
  let cached = false;
  if (pending.length > 0) {
    // One callLLM call for the whole asset's pending chunks (bounded — see
    // EXTRACT_MAX_SEARCH_CHUNKS in extract.ts, default 40). callLLM("embed")
    // further splits this into EMBED_BATCH_SIZE-sized (default 16) HTTP
    // calls to Gemini's batchEmbedContents and applies llm.ts's own
    // retry/backoff/cooldown on 429s — that's the "batch within rate
    // limits" behavior; this stage doesn't need to reimplement it.
    const r = await callLLM("embed", {
      texts: pending.map((p) => p.text_en),
      purpose: "document",
    });
    if (r.output.vectors.length !== pending.length) {
      throw new Error(
        `Expected ${pending.length} vectors, got ${r.output.vectors.length}`,
      );
    }
    usedModel = r.model;
    cached = r.cached;

    // Vectors are already L2-normalized by geminiEmbedBatch() in lib/llm.ts
    // before they reach here — no extra normalization step needed.
    for (let i = 0; i < pending.length; i += 10) {
      const group = pending.slice(i, i + 10);
      const results = await Promise.all(
        group.map((row, j) =>
          db
            .from("doc_chunks")
            .update({
              embedding: JSON.stringify(r.output.vectors[i + j]), // pgvector accepts '[0.1,0.2,...]'
              embedding_model: r.model,
            })
            .eq("id", row.id),
        ),
      );
      const bad = results.find((x) => x.error);
      if (bad?.error)
        throw new Error(`Could not save an embedding: ${bad.error.message}`);
    }
  }

  // Set AUTO_PUBLISH=false to keep uploads as drafts for a review step.
  let published = false;
  if (process.env.AUTO_PUBLISH?.trim() !== "false") {
    const { error: pubErr } = await db
      .from("sites")
      .update({ status: "published" })
      .eq("id", siteId);
    if (pubErr)
      throw new Error(`Could not publish the site: ${pubErr.message}`);
    published = true;
  }

  return {
    output: {
      siteId,
      chunks: rows.length,
      embedded: pending.length,
      cached,
      published,
    },
    provider: "gemini",
    model: usedModel,
  };
};
