#!/usr/bin/env -S npx tsx
/**
 * scripts/seed.ts
 *
 * Batch seed runner for Dharohar:
 * - Scans a folder of images (JPEG, PNG, WebP) and documents (PDF).
 * - Reads an optional metadata CSV for custom titles, notes, kinds, and provenance.
 * - Uploads files to Supabase Storage.
 * - Advances each item through the real Dharohar pipeline stages:
 *     uploaded -> ocr -> extract -> geocode -> embed -> published
 * - Respects free-tier rate limits with configurable throttling and cooldowns.
 * - Full resume support: skips already published files (by content hash) and
 *   resumes interrupted pipelines from where they stopped.
 * - Logs failures to console and writes a timestamped failure audit JSON.
 *
 * USAGE
 *   npx tsx --env-file=.env.local scripts/seed.ts [flags]
 *
 * FLAGS
 *   --dir=<path>           Folder with images/PDFs (default: seed/samples)
 *   --csv=<path>           Path to optional metadata CSV (default: <dir>/metadata.csv if present)
 *   --throttle-ms=N        Pause between items in ms (default: 2000)
 *   --stage-delay-ms=N     Pause between stages of an item in ms (default: 500)
 *   --limit=N              Process at most N items
 *   --force                Reprocess items even if already marked published
 *   --dry-run              Inspect directory and CSV without uploading or running LLMs
 *   --help                 Display this usage guide
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { ALLOWED_MIME_TYPES, type RunnableStage } from "../lib/pipeline";
import { STAGE_HANDLERS } from "../lib/stages";
import type { AssetRow, JobRow } from "../lib/stages/types";
import { getServerSupabase } from "../lib/supabase-server";

type Db = ReturnType<typeof getServerSupabase>;

/* -------------------------------------------------------------------------
 * Types & CLI Argument Parsing
 * ------------------------------------------------------------------------- */

type CsvMetadata = {
  filename: string;
  title?: string;
  notes?: string;
  kind?: "photo" | "scan" | "pano";
  state?: string;
  district?: string;
  category?: string;
  period?: string;
  source_url?: string;
  license?: string;
  attribution?: string;
};

type SeedCliArgs = {
  dir: string;
  csvPath: string | null;
  throttleMs: number;
  stageDelayMs: number;
  limit: number | null;
  force: boolean;
  dryRun: boolean;
};

type ItemRecord = {
  filePath: string;
  filename: string;
  mimeType: (typeof ALLOWED_MIME_TYPES)[number];
  sizeBytes: number;
  contentHash: string;
  metadata?: CsvMetadata;
};

type ProcessResult = {
  filename: string;
  status: "published" | "skipped" | "failed";
  stage?: string;
  siteId?: string;
  error?: string;
  durationMs: number;
};

function parseArgs(argv: string[]): SeedCliArgs {
  const flags = new Set(argv);
  const getStr = (prefix: string): string | null => {
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length).trim() : null;
  };
  const getNum = (prefix: string, fallback: number): number => {
    const val = getStr(prefix);
    if (!val) return fallback;
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const dir = getStr("--dir=") || "seed/samples";
  let csvPath = getStr("--csv=");
  if (!csvPath) {
    const candidate = join(dir, "metadata.csv");
    if (existsSync(candidate)) csvPath = candidate;
  }

  const limitStr = getStr("--limit=");
  const limit = limitStr ? Math.max(1, Number(limitStr)) : null;

  return {
    dir,
    csvPath,
    throttleMs: getNum("--throttle-ms=", 2000),
    stageDelayMs: getNum("--stage-delay-ms=", 500),
    limit,
    force: flags.has("--force"),
    dryRun: flags.has("--dry-run"),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectMimeType(filePath: string): (typeof ALLOWED_MIME_TYPES)[number] | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------
 * Robust Minimal RFC-4180 CSV Parser
 * ------------------------------------------------------------------------- */

function parseCsv(content: string): Record<string, string>[] {
  const lines: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      if (insideQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if ((char === "\r" || char === "\n") && !insideQuotes) {
      if (char === "\r" && content[i + 1] === "\n") i++;
      lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === "," && !inQuotes) {
        fields.push(field.trim());
        field = "";
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const headers = parseRow(lines[0]).map((h) => h.toLowerCase());
  const rows: Record<string, string>[] = [];

  for (let idx = 1; idx < lines.length; idx++) {
    const raw = lines[idx].trim();
    if (!raw) continue;
    const values = parseRow(raw);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] ?? "";
    });
    rows.push(obj);
  }

  return rows;
}

function loadMetadataCsv(path: string): Map<string, CsvMetadata> {
  const map = new Map<string, CsvMetadata>();
  if (!existsSync(path)) return map;

  try {
    const text = readFileSync(path, "utf-8");
    const records = parseCsv(text);
    for (const r of records) {
      const fn = r.filename || r.file || r.name;
      if (!fn) continue;

      let kindVal: "photo" | "scan" | "pano" | undefined;
      const k = (r.kind || "").toLowerCase().trim();
      if (k === "photo" || k === "scan" || k === "pano") {
        kindVal = k;
      }

      map.set(fn.trim(), {
        filename: fn.trim(),
        title: r.title?.trim() || undefined,
        notes: r.notes?.trim() || r.description?.trim() || undefined,
        kind: kindVal,
        state: r.state?.trim() || undefined,
        district: r.district?.trim() || undefined,
        category: r.category?.trim() || undefined,
        period: r.period?.trim() || undefined,
        source_url: r.source_url?.trim() || r.source?.trim() || undefined,
        license: r.license?.trim() || undefined,
        attribution: r.attribution?.trim() || undefined,
      });
    }
  } catch (err) {
    console.warn(`[seed] Warning: could not parse metadata CSV at ${path}:`, err);
  }
  return map;
}

/* -------------------------------------------------------------------------
 * Pipeline Execution via Real Stage Handlers & DB RPCs
 * ------------------------------------------------------------------------- */

const ASSET_COLUMNS =
  "id, site_id, kind, storage_bucket, storage_path, original_filename, mime_type, size_bytes, title, notes, content_hash, language_detected, ocr_text, ocr_confidence, text_en";

async function runRealPipeline(
  db: Db,
  jobId: string,
  stageDelayMs: number,
  logPrefix: string,
): Promise<{ siteId?: string }> {
  while (true) {
    // 1. Fetch current job
    const { data: job, error: jobErr } = await db
      .from("jobs")
      .select("id, asset_id, site_id, stage, status, attempts, max_attempts, error")
      .eq("id", jobId)
      .single();

    if (jobErr || !job) {
      throw new Error(`Job not found: ${jobErr?.message ?? jobId}`);
    }

    if (job.stage === "published" && job.status === "done") {
      return { siteId: job.site_id ?? undefined };
    }

    // 2. Claim next stage
    const { data: claimedRows, error: claimErr } = await db.rpc("claim_job_stage", {
      p_job_id: jobId,
    });
    if (claimErr) {
      throw new Error(`Could not claim stage for job ${jobId}: ${claimErr.message}`);
    }

    const claimed = (claimedRows as JobRow[] | null)?.[0];
    if (!claimed) {
      if (job.status === "failed") {
        throw new Error(`Stage "${job.stage}" failed: ${job.error}`);
      }
      throw new Error(`Stage "${job.stage}" is currently not claimable.`);
    }

    const stage = claimed.stage as RunnableStage;
    if (stage === ("published" as string)) {
      return { siteId: claimed.site_id ?? undefined };
    }

    const handler = STAGE_HANDLERS[stage];
    if (!handler) {
      throw new Error(`No registered handler for pipeline stage "${stage}"`);
    }

    // 3. Load asset row
    const { data: assetData, error: assetErr } = await db
      .from("assets")
      .select(ASSET_COLUMNS)
      .eq("id", claimed.asset_id)
      .single();

    if (assetErr || !assetData) {
      throw new Error(`Could not load asset: ${assetErr?.message ?? "not found"}`);
    }

    const stageStart = Date.now();
    process.stdout.write(` [${stage}`);

    try {
      // Execute the genuine pipeline handler
      const result = await handler({
        db,
        job: claimed,
        asset: assetData as AssetRow,
      });

      // Advance job stage
      const { error: doneErr } = await db.rpc("complete_job_stage", {
        p_job_id: jobId,
        p_stage: stage,
        p_output: result.output,
        p_provider: result.provider ?? null,
        p_model: result.model ?? null,
      });

      if (doneErr) throw new Error(`Could not complete stage: ${doneErr.message}`);

      const stageDur = Date.now() - stageStart;
      process.stdout.write(` ✓ (${stageDur}ms)]`);

      if (stageDelayMs > 0) {
        await sleep(stageDelayMs);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(` ✗ (${msg})]`);

      await db.rpc("fail_job_stage", {
        p_job_id: jobId,
        p_stage: stage,
        p_error: msg,
      });

      throw new Error(`Stage "${stage}" failed: ${msg}`);
    }
  }
}

/* -------------------------------------------------------------------------
 * Main Seeding Orchestration
 * ------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
Dharohar Seeding Pipeline (scripts/seed.ts)
Usage:
  npx tsx --env-file=.env.local scripts/seed.ts [flags]

Flags:
  --dir=<path>         Directory of image and PDF archive files (default: seed/samples)
  --csv=<path>         Optional CSV with metadata (filename, title, notes, kind, source_url)
  --throttle-ms=N      Cooldown in ms between consecutive files (default: 2000)
  --stage-delay-ms=N   Cooldown in ms between stages of a file (default: 500)
  --limit=N            Stop after processing N items
  --force              Reprocess already published items
  --dry-run            Scan directory and check CSV without executing uploads or LLM calls
`);
    process.exit(0);
  }

  const resolvedDir = resolve(process.cwd(), args.dir);
  if (!existsSync(resolvedDir)) {
    console.error(`Error: Seed directory does not exist at "${resolvedDir}".`);
    process.exit(1);
  }

  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  if (!bucket && !args.dryRun) {
    console.error("Error: SUPABASE_STORAGE_BUCKET is not set in environment.");
    process.exit(1);
  }

  // Read metadata CSV if present
  let metaMap = new Map<string, CsvMetadata>();
  if (args.csvPath) {
    const resolvedCsv = resolve(process.cwd(), args.csvPath);
    metaMap = loadMetadataCsv(resolvedCsv);
    console.log(`Loaded metadata for ${metaMap.size} files from ${args.csvPath}`);
  }

  // Scan items in directory
  const files = readdirSync(resolvedDir)
    .filter((f) => !f.startsWith("."))
    .sort();

  const items: ItemRecord[] = [];
  for (const f of files) {
    const full = join(resolvedDir, f);
    if (!statSync(full).isFile()) continue;

    const mime = detectMimeType(full);
    if (!mime) continue;

    const bytes = readFileSync(full);
    const hash = sha256(bytes);
    const meta = metaMap.get(f) || metaMap.get(basename(f));

    items.push({
      filePath: full,
      filename: f,
      mimeType: mime,
      sizeBytes: bytes.byteLength,
      contentHash: hash,
      metadata: meta,
    });

    if (args.limit && items.length >= args.limit) break;
  }

  console.log(`\n======================================================`);
  console.log(`🏛️  Dharohar Seed Pipeline Runner`);
  console.log(`======================================================`);
  console.log(`Found ${items.length} supported archive items in "${args.dir}"`);
  console.log(`Throttling: ${args.throttleMs}ms item cooldown, ${args.stageDelayMs}ms stage cooldown`);
  console.log(`Dry run: ${args.dryRun ? "YES (no DB writes)" : "NO (live pipeline execution)"}`);
  console.log(`======================================================\n`);

  if (items.length === 0) {
    console.log("No images or PDFs found to seed. Exiting.");
    process.exit(0);
  }

  if (args.dryRun) {
    console.log("DRY RUN SUMMARY OF ITEMS:");
    items.forEach((it, idx) => {
      console.log(
        ` [${idx + 1}/${items.length}] ${it.filename} (${(it.sizeBytes / 1024).toFixed(1)} KB, ${it.mimeType})` +
          `${it.metadata?.title ? ` - Title: "${it.metadata.title}"` : ""}` +
          `${it.metadata?.kind ? ` - Kind: ${it.metadata.kind}` : ""}`,
      );
    });
    console.log("\nDry run completed successfully. Omit --dry-run to execute live pipeline.");
    process.exit(0);
  }

  const db = getServerSupabase();
  const results: ProcessResult[] = [];
  const failures: { filename: string; error: string; time: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const prefix = `[${i + 1}/${items.length}] ${it.filename}`;
    const start = Date.now();

    process.stdout.write(`\n${prefix}:`);

    try {
      // 1. Resume Check: Check if an asset with this content hash already exists
      const { data: existingAsset } = await db
        .from("assets")
        .select("id, site_id, kind, original_filename")
        .eq("content_hash", it.contentHash)
        .maybeSingle();

      if (existingAsset && !args.force) {
        // Check job state
        const { data: job } = await db
          .from("jobs")
          .select("id, stage, status")
          .eq("asset_id", existingAsset.id)
          .maybeSingle();

        if (job && job.stage === "published" && job.status === "done") {
          const dur = Date.now() - start;
          process.stdout.write(` [SKIP: Already published (Site ID: ${existingAsset.site_id})] (${dur}ms)\n`);
          results.push({
            filename: it.filename,
            status: "skipped",
            siteId: existingAsset.site_id ?? undefined,
            durationMs: dur,
          });
          continue;
        }
      }

      // 2. Prepare Asset in Supabase Storage
      const bytes = readFileSync(it.filePath);
      const safeName = it.filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const storagePath = `seed/${it.contentHash.slice(0, 16)}/${safeName}`;

      // Upload file to private storage bucket (ignore if exists)
      const { error: uploadErr } = await db.storage
        .from(bucket!)
        .upload(storagePath, bytes, {
          contentType: it.mimeType,
          upsert: true,
        });

      if (uploadErr) {
        throw new Error(`Storage upload failed: ${uploadErr.message}`);
      }

      // Determine initial kind
      let kind: "photo" | "scan" | "pano" =
        it.mimeType === "application/pdf"
          ? "scan"
          : it.metadata?.kind ?? "photo";

      // 3. Upsert Asset Row
      const assetId = existingAsset?.id ?? crypto.randomUUID();
      const meta = it.metadata;

      const { error: assetUpsertErr } = await db.from("assets").upsert(
        {
          id: assetId,
          kind,
          storage_bucket: bucket!,
          storage_path: storagePath,
          original_filename: it.filename,
          mime_type: it.mimeType,
          size_bytes: it.sizeBytes,
          content_hash: it.contentHash,
          title: meta?.title || null,
          notes: meta?.notes || meta?.attribution || null,
        },
        { onConflict: "id" },
      );

      if (assetUpsertErr) {
        throw new Error(`Asset creation failed: ${assetUpsertErr.message}`);
      }

      // 4. Upsert Job Row
      const { data: jobRow, error: jobUpsertErr } = await db
        .from("jobs")
        .upsert(
          {
            asset_id: assetId,
          },
          { onConflict: "asset_id" },
        )
        .select("id")
        .single();

      if (jobUpsertErr || !jobRow) {
        throw new Error(`Job creation failed: ${jobUpsertErr?.message}`);
      }

      // 5. Run Real Pipeline Stages
      const pipelineRes = await runRealPipeline(
        db,
        jobRow.id,
        args.stageDelayMs,
        prefix,
      );

      const dur = Date.now() - start;
      process.stdout.write(` -> Published in ${dur}ms ✨\n`);

      results.push({
        filename: it.filename,
        status: "published",
        siteId: pipelineRes.siteId,
        durationMs: dur,
      });
    } catch (err: unknown) {
      const dur = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n❌ Failed: ${errMsg}\n`);

      results.push({
        filename: it.filename,
        status: "failed",
        error: errMsg,
        durationMs: dur,
      });

      failures.push({
        filename: it.filename,
        error: errMsg,
        time: new Date().toISOString(),
      });
    }

    // Rate-limit throttle between items
    if (i < items.length - 1 && args.throttleMs > 0) {
      await sleep(args.throttleMs);
    }
  }

  // Summary Report
  const publishedCount = results.filter((r) => r.status === "published").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  console.log(`\n======================================================`);
  console.log(`📊 Seeding Batch Summary`);
  console.log(`======================================================`);
  console.log(`Total Scanned:  ${items.length}`);
  console.log(`Published (✓):  ${publishedCount}`);
  console.log(`Resumed/Skipped: ${skippedCount}`);
  console.log(`Failed (✗):     ${failedCount}`);
  console.log(`======================================================`);

  if (failures.length > 0) {
    const failureLogPath = `seed-failures-${Date.now()}.json`;
    writeFileSync(failureLogPath, JSON.stringify(failures, null, 2), "utf-8");
    console.log(`⚠️  Wrote ${failures.length} failure details to: ${failureLogPath}`);
  }

  console.log("\nDone.");
}

void main();
