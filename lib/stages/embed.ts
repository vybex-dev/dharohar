// lib/stages/embed.ts
import "server-only";
import { callLLM, embeddingModelId } from "@/lib/llm";
import { PUBLISH_BLOCKED_NEEDS_LOCATION } from "@/lib/pipeline";
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

  const model = embeddingModelId();
  const pending = rows.filter((r) => r.embedding_model !== model);

  let usedModel = model;
  let cached = false;
  if (pending.length > 0) {
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
      if (bad?.error)
        throw new Error(`Could not save an embedding: ${bad.error.message}`);
    }
  }

  // Set AUTO_PUBLISH=false to keep uploads as drafts for a review step.
  let published = false;
  let publishBlockedReason: string | null = null;
  if (process.env.AUTO_PUBLISH?.trim() !== "false") {
    const { data: locData, error: locErr } = await db
      .from("sites")
      .select("needs_manual_location")
      .eq("id", siteId)
      .maybeSingle();
    if (locErr)
      throw new Error(`Could not check site location: ${locErr.message}`);

    // NEVER auto-publish a site with no location: /api/sites filters out
    // rows with null lat/lng, so a "published" site with no location would
    // simply never render a marker — looking published but invisible. It
    // stays 'draft' until a human places a pin (sites.location_source =
    // 'manual', see lib/stages/geocode.ts), which then flips
    // needs_manual_location back to false.
    if (
      (locData as { needs_manual_location: boolean } | null)
        ?.needs_manual_location
    ) {
      publishBlockedReason = PUBLISH_BLOCKED_NEEDS_LOCATION;
    } else {
      const { error: pubErr } = await db
        .from("sites")
        .update({ status: "published" })
        .eq("id", siteId);
      if (pubErr)
        throw new Error(`Could not publish the site: ${pubErr.message}`);
      published = true;
    }
  }

  return {
    output: {
      siteId,
      chunks: rows.length,
      embedded: pending.length,
      cached,
      published,
      publishBlockedReason,
    },
    provider: "gemini",
    model: usedModel,
  };
};
