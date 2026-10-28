import "server-only";
import os from "node:os";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  callLLM,
  LLMChainError,
  LLMConfigError,
  type LLMResult,
  type OcrOutput,
} from "@/lib/llm";
import type { StageHandler } from "./types";

/* =========================================================================
 * Config (all defaults are my own design choices, not provider limits)
 * ========================================================================= */

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function config() {
  return {
    maxImagePx: envInt("OCR_MAX_IMAGE_PX", 2400, 400),
    pagesPerChunk: envInt("OCR_PDF_PAGES_PER_CHUNK", 3, 1),
    maxPages: envInt("OCR_MAX_PDF_PAGES", 12, 1),
    concurrency: envInt("OCR_CONCURRENCY", 2, 1),
    stageBudgetMs: envInt("OCR_STAGE_BUDGET_MS", 20_000, 3_000),
    tesseractEnabled: process.env.OCR_TESSERACT_FALLBACK?.trim() !== "false",
    tesseractLangs: process.env.OCR_TESSERACT_LANGS?.trim() || "hin+guj+eng",
    tesseractLangPath: process.env.OCR_TESSERACT_LANG_PATH?.trim() || undefined,
    tesseractTimeoutMs: envInt("OCR_TESSERACT_TIMEOUT_MS", 20_000, 3_000),
  };
}

const MIN_CHUNK_BUDGET_MS = 2_000;

/* =========================================================================
 * Types
 * ========================================================================= */

export type RunOcrInput = {
  bytes: Uint8Array;
  mimeType: string;
  kind?: "photo" | "scan";
  skipCache?: boolean;
  /** Skip the LLM chain and go straight to Tesseract (images only). For testing. */
  forceFallback?: boolean;
  /** Override OCR_STAGE_BUDGET_MS. */
  budgetMs?: number;
};

export type OcrChunkMeta = {
  label: string;
  pages: [number, number] | null;
  provider: string;
  model: string;
  language: string;
  chars: number;
  confidence: number | null;
  cached: boolean;
  latencyMs: number;
};

type ChunkResult = OcrChunkMeta & { text: string; visualDescription: string };

export type OcrRunResult = {
  text: string;
  language: string;
  confidence: number | null;
  visualDescription: string;
  providers: string[];
  models: string[];
  chunks: OcrChunkMeta[];
  totalPages: number | null;
  pagesProcessed: number | null;
  truncated: boolean;
  usedFallback: boolean;
  preprocess: string;
};

type Unit = {
  label: string;
  pages: [number, number] | null;
  base64: string;
  mimeType: string;
  hint: string;
};

type Outcome =
  | { ok: true; unit: Unit; r: LLMResult<OcrOutput> }
  | { ok: false; unit: Unit; error: unknown; skipped: boolean };

/* =========================================================================
 * Small helpers
 * ========================================================================= */

const sleepFree = <T>(v: T) => v;
void sleepFree;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

const LANG_NAMES: Record<string, string> = {
  hindi: "hi",
  gujarati: "gu",
  english: "en",
  marathi: "mr",
  sanskrit: "sa",
  mixed: "mixed",
};

function normLang(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "und";
  if (LANG_NAMES[s]) return LANG_NAMES[s];
  return s.split(/[-_]/)[0] || "und";
}

/** Script-based guess for Tesseract output. Cannot tell Hindi from Marathi or Sanskrit. */
function detectScript(text: string): string {
  const deva = (text.match(/[\u0900-\u097F]/g) ?? []).length;
  const guj = (text.match(/[\u0A80-\u0AFF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = deva + guj + latin;
  if (total === 0) return "und";
  const top = Math.max(deva, guj, latin);
  if (top / total < 0.7) return "mixed";
  return top === deva ? "hi" : top === guj ? "gu" : "en";
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/* =========================================================================
 * Preprocessing: sharp (images) and pdf-lib (PDFs)
 * ========================================================================= */

type Prepared = {
  bytes: Uint8Array;
  base64: string;
  mimeType: string;
  note: string;
};

async function prepareImage(
  bytes: Uint8Array,
  mimeType: string,
  maxPx: number,
): Promise<Prepared> {
  try {
    const { data, info } = await sharp(Buffer.from(bytes), { failOn: "none" })
      .rotate() // auto-orient from EXIF
      .resize({
        width: maxPx,
        height: maxPx,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      base64: data.toString("base64"),
      mimeType: "image/jpeg",
      note: `sharp: auto-rotated, fit within ${maxPx}px, ${info.width}x${info.height} jpeg`,
    };
  } catch (e) {
    console.warn(
      `[ocr] sharp preprocessing failed, using the original bytes: ${errMsg(e)}`,
    );
    return {
      bytes,
      base64: Buffer.from(bytes).toString("base64"),
      mimeType,
      note: `sharp failed (${errMsg(e)}); original bytes used`,
    };
  }
}

async function splitPdf(
  bytes: Uint8Array,
  pagesPerChunk: number,
  maxPages: number,
): Promise<{
  totalPages: number;
  processed: number;
  chunks: Array<{ from: number; to: number; base64: string }>;
}> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new Error(
      `Could not read the PDF (encrypted or damaged?): ${errMsg(e)}`,
    );
  }

  const totalPages = src.getPageCount();
  if (totalPages === 0) throw new Error("The PDF has no pages");
  const processed = Math.min(totalPages, maxPages);

  // Small PDF: send the original bytes untouched (best fidelity, deterministic cache key).
  if (totalPages <= pagesPerChunk) {
    return {
      totalPages,
      processed,
      chunks: [
        {
          from: 1,
          to: totalPages,
          base64: Buffer.from(bytes).toString("base64"),
        },
      ],
    };
  }

  const chunks: Array<{ from: number; to: number; base64: string }> = [];
  for (let start = 0; start < processed; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, processed);
    const out = await PDFDocument.create({ updateMetadata: false });
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    // Fixed metadata keeps the output bytes (and so the LLM cache key) stable between runs.
    out.setCreationDate(new Date(0));
    out.setModificationDate(new Date(0));
    out.setProducer("dharohar");
    out.setCreator("dharohar");
    const saved = await out.save();
    chunks.push({
      from: start + 1,
      to: end,
      base64: Buffer.from(saved).toString("base64"),
    });
  }
  return { totalPages, processed, chunks };
}

/* =========================================================================
 * Tesseract.js fallback (images only)
 * ========================================================================= */

async function tesseractOcr(
  bytes: Uint8Array,
  langs: string,
  langPath: string | undefined,
  timeoutMs: number,
): Promise<{ text: string; confidence: number | null }> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(langs, 1, {
    cachePath: os.tmpdir(), // language data is downloaded once, then reused while the instance is warm
    ...(langPath ? { langPath } : {}),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Tesseract timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    const { data } = await Promise.race([
      worker.recognize(Buffer.from(bytes)),
      timeout,
    ]);
    const conf =
      typeof data.confidence === "number" ? data.confidence / 100 : null; // tesseract: 0-100
    return {
      text: (data.text ?? "").trim(),
      confidence: conf === null ? null : Math.min(1, Math.max(0, conf)),
    };
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}

/* =========================================================================
 * Core OCR (no database access, so the dev route can call it directly)
 * ========================================================================= */

function aggregate(chunks: ChunkResult[]) {
  const withText = chunks.filter((c) => c.text.trim() !== "");
  const text = withText.map((c) => c.text.trim()).join("\n\n");

  const weights = new Map<string, number>();
  for (const c of withText) {
    weights.set(c.language, (weights.get(c.language) ?? 0) + c.text.length);
  }
  let language = chunks[0]?.language ?? "und";
  if (weights.size > 0) {
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    const [topLang, topWeight] = [...weights.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0] as [string, number];
    language = topWeight / total >= 0.7 ? topLang : "mixed";
  }

  let confidence: number | null = null;
  const scored = withText.filter((c) => c.confidence !== null);
  if (scored.length > 0) {
    const w = scored.reduce((s, c) => s + c.text.length, 0);
    confidence =
      scored.reduce((s, c) => s + (c.confidence as number) * c.text.length, 0) /
      w;
    confidence = Math.min(1, Math.max(0, Number(confidence.toFixed(3))));
  }

  return { text, language, confidence };
}

function isProviderExhaustion(e: unknown): boolean {
  if (e instanceof LLMConfigError) return true; // nothing configured is also "no provider answered"
  if (e instanceof LLMChainError)
    return e.attempts.some((a) => a.kind !== "budget");
  return false;
}

function toMeta(c: ChunkResult): OcrChunkMeta {
  const { text: _text, visualDescription: _vd, ...meta } = c;
  void _text;
  void _vd;
  return meta;
}

export async function runOcr(input: RunOcrInput): Promise<OcrRunResult> {
  const cfg = config();
  const started = Date.now();
  const deadline = started + (input.budgetMs ?? cfg.stageBudgetMs);

  const isPdf = input.mimeType === "application/pdf";
  const isImage = input.mimeType.startsWith("image/");
  if (!isPdf && !isImage)
    throw new Error(
      `OCR does not support "${input.mimeType || "unknown"}" files`,
    );
  if (isPdf && input.forceFallback)
    throw new Error("The Tesseract fallback does not support PDFs");

  const kindHint =
    input.kind === "scan"
      ? "This is a scanned document page."
      : "This is a photograph; any text is likely on signboards, inscriptions or plaques.";

  /* ---- build the work units ---- */
  let units: Unit[];
  let totalPages: number | null = null;
  let pagesProcessed: number | null = null;
  let preprocess: string;
  let imageBytesForFallback: Uint8Array | null = null;

  if (isPdf) {
    const split = await splitPdf(input.bytes, cfg.pagesPerChunk, cfg.maxPages);
    totalPages = split.totalPages;
    pagesProcessed = split.processed;
    preprocess = `pdf-lib: ${split.chunks.length} chunk(s) of up to ${cfg.pagesPerChunk} page(s)`;
    units = split.chunks.map((c) => ({
      label: `pages ${c.from}-${c.to}`,
      pages: [c.from, c.to] as [number, number],
      base64: c.base64,
      mimeType: "application/pdf",
      hint: `This is pages ${c.from}-${c.to} of a ${split.totalPages}-page scanned document.`,
    }));
  } else {
    const prep = await prepareImage(
      input.bytes,
      input.mimeType,
      cfg.maxImagePx,
    );
    preprocess = prep.note;
    imageBytesForFallback = prep.bytes;
    units = [
      {
        label: "image",
        pages: null,
        base64: prep.base64,
        mimeType: prep.mimeType,
        hint: kindHint,
      },
    ];
  }

  const truncated =
    totalPages !== null &&
    pagesProcessed !== null &&
    totalPages > pagesProcessed;

  const finish = (
    chunks: ChunkResult[],
    usedFallback: boolean,
  ): OcrRunResult => {
    const agg = aggregate(chunks);
    return {
      ...agg,
      visualDescription:
        chunks.find((c) => c.visualDescription.trim() !== "")
          ?.visualDescription ?? "",
      providers: uniq(chunks.map((c) => c.provider)),
      models: uniq(chunks.map((c) => c.model)),
      chunks: chunks.map(toMeta),
      totalPages,
      pagesProcessed,
      truncated,
      usedFallback,
      preprocess,
    };
  };

  const runFallback = async (): Promise<OcrRunResult> => {
    if (!imageBytesForFallback)
      throw new Error("The Tesseract fallback only supports single images");
    const t0 = Date.now();
    const r = await tesseractOcr(
      imageBytesForFallback,
      cfg.tesseractLangs,
      cfg.tesseractLangPath,
      cfg.tesseractTimeoutMs,
    );
    console.log(
      JSON.stringify({
        evt: "ocr",
        provider: "tesseract",
        ms: Date.now() - t0,
        chars: r.text.length,
      }),
    );
    return finish(
      [
        {
          label: "image",
          pages: null,
          provider: "tesseract",
          model: `tesseract.js:${cfg.tesseractLangs}`,
          language: detectScript(r.text),
          chars: r.text.length,
          confidence: r.confidence,
          cached: false,
          latencyMs: Date.now() - t0,
          text: r.text,
          visualDescription: "",
        },
      ],
      true,
    );
  };

  if (input.forceFallback) return runFallback();

  /* ---- LLM chain, one callLLM per unit ---- */
  const outcomes = await mapPool<Unit, Outcome>(
    units,
    cfg.concurrency,
    async (unit) => {
      const remaining = deadline - Date.now();
      if (remaining < MIN_CHUNK_BUDGET_MS) {
        return {
          ok: false,
          unit,
          error: new Error("Stage time budget exhausted"),
          skipped: true,
        };
      }
      try {
        const r = await callLLM(
          "ocr",
          {
            image: { base64: unit.base64, mimeType: unit.mimeType },
            hint: unit.hint,
          },
          { skipCache: input.skipCache, budgetMs: remaining },
        );
        return { ok: true, unit, r };
      } catch (error) {
        return { ok: false, unit, error, skipped: false };
      }
    },
  );

  const failures = outcomes.filter(
    (o): o is Extract<Outcome, { ok: false }> => !o.ok,
  );

  if (failures.length === 0) {
    const chunks: ChunkResult[] = outcomes.map((o) => {
      if (!o.ok) throw new Error("unreachable");
      return {
        label: o.unit.label,
        pages: o.unit.pages,
        provider: o.r.provider,
        model: o.r.model,
        language: normLang(o.r.output.language),
        chars: o.r.output.text.length,
        confidence:
          o.r.output.text.trim() === "" ? null : o.r.output.confidence,
        cached: o.r.cached,
        latencyMs: o.r.latencyMs,
        text: o.r.output.text,
        visualDescription: o.r.output.visual_description,
      };
    });
    return finish(chunks, false);
  }

  /* ---- failure handling ---- */
  const firstReal = failures.find((f) => !f.skipped) ?? failures[0];
  const exhausted = isProviderExhaustion(firstReal?.error);

  if (!isPdf && exhausted && cfg.tesseractEnabled) {
    console.warn(
      `[ocr] all LLM providers failed (${errMsg(firstReal?.error).slice(0, 300)}); falling back to Tesseract`,
    );
    return runFallback();
  }

  throw new Error(
    `OCR failed for ${failures.length} of ${units.length} chunk(s): ${errMsg(firstReal?.error).slice(0, 500)}. ` +
      "Chunks that finished are cached, so a retry resumes from where this stopped.",
  );
}

/* =========================================================================
 * Pipeline stage
 * ========================================================================= */

export const ocrStage: StageHandler = async ({ db, asset }) => {
  const { data: blob, error: dlErr } = await db.storage
    .from(asset.storage_bucket)
    .download(asset.storage_path);
  if (dlErr || !blob) {
    throw new Error(
      `Could not download "${asset.storage_path}": ${dlErr?.message ?? "no data"}`,
    );
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const result = await runOcr({
    bytes,
    mimeType: asset.mime_type ?? "",
    kind: asset.kind,
  });

  const text = result.text.trim();
  const provider = result.providers.join("+");
  const model = result.models.join("+");

  // Updating by primary key is idempotent: a re-run overwrites the same row.
  const { error: updErr } = await db
    .from("assets")
    .update({
      ocr_text: text || null,
      // English text is only set here when the source is already English; the extract stage translates the rest.
      text_en: result.language === "en" && text ? text : null,
      language_detected: result.language,
      ocr_provider: provider,
      ocr_model: model,
      ocr_confidence: result.confidence,
    })
    .eq("id", asset.id);
  if (updErr) throw new Error(`Could not save OCR result: ${updErr.message}`);

  return {
    output: {
      language: result.language,
      chars: text.length,
      confidence: result.confidence,
      visual_description: result.visualDescription, // the extract stage can read this from job_stage_runs
      chunks: result.chunks,
      totalPages: result.totalPages,
      pagesProcessed: result.pagesProcessed,
      truncated: result.truncated,
      usedFallback: result.usedFallback,
      preprocess: result.preprocess,
    },
    provider,
    model,
  };
};
