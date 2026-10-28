#!/usr/bin/env -S npx tsx
/**
 * scripts/reembed-all.ts
 *
 * One-off script: re-embeds doc_chunks under the CURRENT GEMINI_MODEL_EMBED.
 * Each chunk's text_en already includes the site summary for chunk_index 0
 * (see lib/stages/embed.ts), so this covers summaries too — there's no
 * separate summary embedding to handle.
 *
 * Run this after changing GEMINI_MODEL_EMBED to a different model (same
 * 768 dims — see the dimension note below if you're also changing dims).
 * You do NOT need this for normal operation: the pipeline's embed stage
 * (lib/stages/embed.ts) already embeds new chunks and skips ones already
 * on the current model as part of every upload.
 *
 * USAGE
 *   npx tsx --env-file=.env.local scripts/reembed-all.ts [flags]
 *
 *   --dry-run        Report what would be touched. No API or DB writes.
 *   --force          Re-embed EVERY chunk, even ones already on the
 *                     current model (e.g. if you suspect a bad run).
 *   --batch-size=N   Chunks per callLLM("embed") call (default 200).
 *                     callLLM further splits this into EMBED_BATCH_SIZE
 *                     (default 16) HTTP calls — this just bounds payload
 *                     size per call, it is not the Gemini-facing batch size.
 *   --delay-ms=N     Extra pause between batches, on top of llm.ts's own
 *                     retry/backoff. Raise this if you hit your Gemini
 *                     free-tier RPM limit even with batching — VERIFY your
 *                     actual limit on the Gemini API quota page, this
 *                     script does not know it.
 *
 * Safe to re-run: failed batches are logged and left pending (their
 * embedding_model is unchanged), so running the script again only retries
 * what didn't finish.
 *
 * Requires Node >= 20.6 for --env-file. Check: node -v
 */

import { callLLM, embeddingModelId } from "../lib/llm";
import { EMBEDDING_DIMENSIONS } from "../lib/pipeline";
import { getServerSupabase } from "../lib/supabase-server";

type Db = ReturnType<typeof getServerSupabase>;

type ChunkRow = {
  id: string;
  site_id: string;
  asset_id: string | null;
  chunk_index: number;
  text_en: string;
  embedding_model: string | null;
};

type Args = {
  dryRun: boolean;
  force: boolean;
  batchSize: number;
  delayMs: number;
};

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv);
  const get = (prefix: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(prefix));
    if (!hit) return fallback;
    const n = Number(hit.slice(prefix.length));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    dryRun: flags.has("--dry-run"),
    force: flags.has("--force"),
    batchSize: get("--batch-size=", 200),
    delayMs: get("--delay-ms=", 0),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PAGE_SIZE = 1000; // PostgREST's default row cap per request

async function fetchPage(db: Db, offset: number): Promise<ChunkRow[]> {
  const { data, error } = await db
    .from("doc_chunks")
    .select("id, site_id, asset_id, chunk_index, text_en, embedding_model")
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`Could not list doc_chunks: ${error.message}`);
  return (data ?? []) as ChunkRow[];
}

async function embedBatch(
  db: Db,
  rows: ChunkRow[],
): Promise<{ embedded: number; skippedEmpty: number }> {
  const usable = rows.filter((r) => r.text_en.trim() !== "");
  const skippedEmpty = rows.length - usable.length;
  if (usable.length === 0) return { embedded: 0, skippedEmpty };

  const r = await callLLM("embed", {
    texts: usable.map((u) => u.text_en),
    purpose: "document",
  });
  if (r.output.vectors.length !== usable.length) {
    throw new Error(
      `Expected ${usable.length} vectors, got ${r.output.vectors.length}`,
    );
  }

  for (let i = 0; i < usable.length; i += 10) {
    const group = usable.slice(i, i + 10);
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

  return { embedded: usable.length, skippedEmpty };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = embeddingModelId(); // reads GEMINI_MODEL_EMBED; throws if unset
  console.log(
    `[reembed] target model: ${model} (${EMBEDDING_DIMENSIONS} dims) ` +
      `force=${args.force} dryRun=${args.dryRun} batchSize=${args.batchSize}`,
  );

  const db = getServerSupabase();
  let offset = 0;
  let totalSeen = 0;
  let totalEmbedded = 0;
  let totalSkippedEmpty = 0;
  let totalFailedBatches = 0;
  const byOldModel = new Map<string, number>();

  for (;;) {
    const page = await fetchPage(db, offset);
    if (page.length === 0) break;
    offset += page.length; // advance by the FULL page, even if few rows are pending

    const pending = args.force
      ? page
      : page.filter((r) => r.embedding_model !== model);
    if (pending.length === 0) continue;

    totalSeen += pending.length;
    for (const row of pending) {
      const key = row.embedding_model ?? "(never embedded)";
      byOldModel.set(key, (byOldModel.get(key) ?? 0) + 1);
    }

    if (args.dryRun) continue;

    for (let i = 0; i < pending.length; i += args.batchSize) {
      const batch = pending.slice(i, i + args.batchSize);
      try {
        const { embedded, skippedEmpty } = await embedBatch(db, batch);
        totalEmbedded += embedded;
        totalSkippedEmpty += skippedEmpty;
        console.log(
          `[reembed] embedded ${totalEmbedded}/${totalSeen} so far ` +
            `(this batch: ${embedded}, empty skipped: ${skippedEmpty})`,
        );
      } catch (e) {
        totalFailedBatches += 1;
        console.error(
          `[reembed] batch starting at doc_chunks.id=${batch[0]?.id} failed: ` +
            `${e instanceof Error ? e.message : String(e)}. Left pending — re-run to retry.`,
        );
      }
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
  }

  console.log("\n[reembed] summary");
  console.log(
    `  rows ${args.dryRun ? "that would be touched" : "seen"}: ${totalSeen}`,
  );
  for (const [old, count] of byOldModel) {
    console.log(`    from "${old}": ${count}`);
  }
  if (!args.dryRun) {
    console.log(`  embedded: ${totalEmbedded}`);
    console.log(`  skipped (empty text_en): ${totalSkippedEmpty}`);
    console.log(
      `  failed batches: ${totalFailedBatches}` +
        (totalFailedBatches > 0 ? " — re-run the script to retry" : ""),
    );
  }
}

main().catch((e) => {
  console.error("[reembed] fatal:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
