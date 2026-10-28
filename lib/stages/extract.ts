import "server-only";
import { callLLM, type ExtractInput, type LLMResult } from "@/lib/llm";
import {
  EXTRACT_FIELDS,
  type ExtractField,
  type ExtractOutput,
} from "@/lib/extract-schema";
import type { StageHandler } from "./types";
import { sha256Hex } from "./util";

/* =========================================================================
 * Config (defaults are my own design choices, not provider limits)
 * ========================================================================= */

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function config() {
  return {
    chunkChars: envInt("EXTRACT_CHUNK_CHARS", 3500, 800), // translation chunk size
    maxChunks: envInt("EXTRACT_MAX_CHUNKS", 6, 1),
    concurrency: envInt("EXTRACT_CONCURRENCY", 2, 1),
    stageBudgetMs: envInt("EXTRACT_STAGE_BUDGET_MS", 45_000, 5_000),
    searchChunkChars: envInt("EXTRACT_SEARCH_CHUNK_CHARS", 1000, 300),
    maxSearchChunks: envInt("EXTRACT_MAX_SEARCH_CHUNKS", 40, 1),
    uncertainBelow: envInt("EXTRACT_UNCERTAIN_BELOW_PCT", 60, 1) / 100,
  };
}

const MIN_CALL_MS = 3_000;
const LOW_OCR_CONFIDENCE = 0.7;

/* =========================================================================
 * Text splitting (pure)
 * ========================================================================= */

function splitLong(paragraph: string, max: number): string[] {
  // Sentence ends: . ! ? and the Devanagari danda characters used in Hindi and Gujarati text
  const sentences = paragraph.match(/[^.!?।॥]+[.!?।॥]*\s*/g) ?? [paragraph];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      let i = 0;
      while (i < s.length) {
        let end = Math.min(i + max, s.length);
        if (end < s.length) {
          const space = s.lastIndexOf(" ", end);
          if (space > i + max / 2) end = space; // cut at a space, not inside a word
        }
        out.push(s.slice(i, end).trim());
        i = end;
      }
      continue;
    }
    if ((cur + s).length > max) {
      if (cur.trim()) out.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((x) => x !== "");
}

/** Splits at paragraph breaks first, then sentence ends, packing pieces up to `max` characters. */
export function splitText(text: string, max: number): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean === "") return [];
  if (clean.length <= max) return [clean];

  const pieces: string[] = [];
  for (const p of clean
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    if (p.length <= max) pieces.push(p);
    else pieces.push(...splitLong(p, max));
  }

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur === "") cur = piece;
    else if (cur.length + 2 + piece.length <= max) cur += `\n\n${piece}`;
    else {
      chunks.push(cur);
      cur = piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* =========================================================================
 * LLM extraction (no database access, so the dev route can call it)
 * ========================================================================= */

export type ExtractRunInput = {
  text: string;
  language?: string | null;
  title?: string | null;
  notes?: string | null;
  visualDescription?: string | null;
  skipCache?: boolean;
  budgetMs?: number;
};

export type ExtractCallMeta = {
  label: string;
  mode: "full" | "translate";
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
};

export type ExtractRunResult = {
  fields: ExtractOutput; // metadata from the first chunk
  textEn: string;
  chunksTotal: number;
  chunksTranslated: number;
  truncated: boolean;
  metadataBasedOnChars: number;
  providers: string[];
  models: string[];
  calls: ExtractCallMeta[];
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
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

/** Calls the model, checks the output, and retries once with the cache bypassed if it is unusable. */
async function callExtract(
  input: ExtractInput,
  check: (o: ExtractOutput) => string | null,
  opts: { skipCache?: boolean; deadline: number },
): Promise<LLMResult<ExtractOutput>> {
  const attempt = (skipCache: boolean) => {
    const remaining = opts.deadline - Date.now();
    if (remaining < MIN_CALL_MS)
      throw new Error("Extract stage time budget exhausted");
    return callLLM("extract", input, { skipCache, budgetMs: remaining });
  };

  let r = await attempt(opts.skipCache === true);
  let problem = check(r.output);
  if (problem === null) return r;

  console.warn(
    `[extract] unusable output (${problem}); retrying once without the cache`,
  );
  r = await attempt(true);
  problem = check(r.output);
  if (problem !== null)
    throw new Error(
      `Extraction returned unusable output after a retry: ${problem}`,
    );
  return r;
}

export async function runExtractLLM(
  input: ExtractRunInput,
): Promise<ExtractRunResult> {
  const cfg = config();
  const deadline = Date.now() + (input.budgetMs ?? cfg.stageBudgetMs);

  const text = (input.text ?? "").trim();
  const language = input.language?.trim().toLowerCase() || undefined;
  const isEnglish = language === "en";
  const needsTranslation = text !== "" && !isEnglish;

  const pieces = splitText(text, cfg.chunkChars);
  const units = pieces.slice(0, cfg.maxChunks);
  const truncated = needsTranslation && pieces.length > units.length;
  const total = pieces.length;

  const base = {
    language,
    title: input.title ?? undefined,
    notes: input.notes ?? undefined,
    visualDescription: input.visualDescription ?? undefined,
  };
  const calls: ExtractCallMeta[] = [];
  const record = (
    label: string,
    mode: "full" | "translate",
    r: LLMResult<ExtractOutput>,
  ) =>
    calls.push({
      label,
      mode,
      provider: r.provider,
      model: r.model,
      cached: r.cached,
      latencyMs: r.latencyMs,
    });

  // 1. First chunk: full extraction (and its translation)
  const head = await callExtract(
    {
      ...base,
      text: units[0] ?? "",
      mode: "full",
      partOf: total > 1 ? { index: 1, total } : undefined,
    },
    (o) =>
      o.summary_en === ""
        ? "summary_en is empty"
        : needsTranslation && o.text_en === ""
          ? "text_en is empty for non-English text"
          : null,
    { skipCache: input.skipCache, deadline },
  );
  record(total > 1 ? `chunk 1/${total}` : "document", "full", head);

  // 2. Remaining chunks: translation only (not needed for English text)
  const rest = needsTranslation ? units.slice(1) : [];
  const outcomes = await mapPool(rest, cfg.concurrency, async (piece, i) => {
    try {
      const r = await callExtract(
        {
          ...base,
          text: piece,
          mode: "translate",
          partOf: { index: i + 2, total },
        },
        (o) => (o.text_en === "" ? "text_en is empty" : null),
        { skipCache: input.skipCache, deadline },
      );
      return { ok: true as const, r, label: `chunk ${i + 2}/${total}` };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  const translations: string[] = [head.output.text_en];
  for (const o of outcomes) {
    if (o.ok) {
      record(o.label, "translate", o.r);
      translations.push(o.r.output.text_en);
    }
  }
  const failed = outcomes.find((o) => !o.ok);
  if (failed && !failed.ok) {
    throw new Error(
      `Translation failed for ${outcomes.filter((o) => !o.ok).length} of ${rest.length} later chunk(s): ` +
        `${errMsg(failed.error).slice(0, 400)}. Finished chunks are cached, so a retry resumes from here.`,
    );
  }

  const textEn = isEnglish
    ? text
    : translations.filter((t) => t !== "").join("\n\n");

  return {
    fields: head.output,
    textEn,
    chunksTotal: total,
    chunksTranslated: needsTranslation ? units.length : 0,
    truncated,
    metadataBasedOnChars: units[0]?.length ?? 0,
    providers: uniq(calls.map((c) => c.provider)),
    models: uniq(calls.map((c) => c.model)),
    calls,
  };
}

/* =========================================================================
 * Pipeline stage
 * ========================================================================= */

function hasValue(f: ExtractOutput, k: ExtractField): boolean {
  switch (k) {
    case "crafts":
      return f.crafts.length > 0;
    case "type":
      return true;
    case "summary_en":
    case "text_en":
      return f[k] !== "";
    default:
      return f[k] !== null;
  }
}

export const extractStage: StageHandler = async ({ db, job, asset }) => {
  const cfg = config();

  // Image description produced by the OCR stage
  const { data: ocrRun, error: runErr } = await db
    .from("job_stage_runs")
    .select("output")
    .eq("job_id", job.id)
    .eq("stage", "ocr")
    .maybeSingle();
  if (runErr)
    throw new Error(`Could not read OCR stage output: ${runErr.message}`);
  const vd = (ocrRun?.output as { visual_description?: unknown } | null)
    ?.visual_description;
  const visualDescription =
    typeof vd === "string" && vd.trim() !== "" ? vd.trim() : null;

  const ocrText = asset.ocr_text?.trim() ?? "";
  const userTitle = asset.title?.trim() || null;
  const userNotes = asset.notes?.trim() || null;
  if (!ocrText && !userTitle && !userNotes && !visualDescription) {
    throw new Error(
      "Nothing to extract from: no OCR text, title, notes or image description",
    );
  }

  const run = await runExtractLLM({
    text: ocrText,
    language: asset.language_detected,
    title: userTitle,
    notes: userNotes,
    visualDescription,
  });
  const f = run.fields;
  const textEn = run.textEn;
  const summary = f.summary_en;

  /* ---- name, confidence and uncertainty ---- */
  const nameEn =
    userTitle ?? f.name ?? `Untitled upload ${asset.id.slice(0, 8)}`;
  const effective: ExtractOutput = {
    ...f,
    text_en: textEn,
    name: userTitle ?? f.name,
  };

  const conf = { ...f.field_confidence };
  if (userTitle) conf.name = 1; // typed by the contributor
  const ocrConf = asset.ocr_confidence;
  const textCap = ocrConf ?? 1;
  conf.text_en =
    asset.language_detected === "en"
      ? textCap
      : Math.min(conf.text_en, textCap);

  const uncertain = new Set<ExtractField>(
    f.uncertain_fields.filter((k) => hasValue(effective, k)),
  );
  for (const k of EXTRACT_FIELDS) {
    if (hasValue(effective, k) && conf[k] < cfg.uncertainBelow)
      uncertain.add(k);
  }
  if (ocrConf !== null && ocrConf < LOW_OCR_CONFIDENCE && textEn !== "")
    uncertain.add("text_en");
  if (userTitle) uncertain.delete("name");
  else if (!f.name) uncertain.add("name");
  const uncertainFields = EXTRACT_FIELDS.filter((k) => uncertain.has(k));

  const scored = EXTRACT_FIELDS.filter((k) => hasValue(effective, k)).map(
    (k) => conf[k],
  );
  const extractionConfidence =
    scored.length > 0
      ? Number((scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(3))
      : null;

  /* ---- site row (status is never touched, so a re-run cannot un-publish) ---- */
  const tags = [
    ...new Set([
      ...(f.type !== "other" ? [f.type] : []),
      ...f.crafts.map((c) => c.toLowerCase()),
      "upload",
    ]),
  ].slice(0, 15);

  const { data: site, error: siteErr } = await db
    .from("sites")
    .upsert(
      {
        slug: `upload-${asset.id}`,
        name_en: nameEn,
        name_local: f.name_local,
        category: f.type,
        state: f.state,
        district: f.district,
        region: f.region,
        address_text: f.place_name,
        period: f.era,
        crafts: f.crafts,
        tags,
        summary_en: summary,
        folklore_notes: f.folklore_notes,
        uncertain_fields: uncertainFields,
        field_confidence: conf,
        extraction_confidence: extractionConfidence,
        origin: "upload",
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (siteErr || !site) {
    throw new Error(
      `Could not save the draft site: ${siteErr?.message ?? "no row returned"}`,
    );
  }
  const siteId = (site as { id: string }).id;

  /* ---- searchable chunks: 0 = headline + summary, 1.. = English text ---- */
  const headline = [
    nameEn,
    f.type !== "other" ? f.type : null,
    f.place_name,
    f.era,
  ]
    .filter((x): x is string => !!x)
    .join(" | ");
  const bodyChunks = splitText(textEn, cfg.searchChunkChars).slice(
    0,
    cfg.maxSearchChunks - 1,
  );
  const chunkTexts = [`${headline}\n${summary}`, ...bodyChunks];

  const { data: existing, error: exErr } = await db
    .from("doc_chunks")
    .select("chunk_index, content_hash")
    .eq("asset_id", asset.id);
  if (exErr)
    throw new Error(`Could not read existing chunks: ${exErr.message}`);
  const existingHash = new Map<number, string | null>(
    (
      (existing ?? []) as Array<{
        chunk_index: number;
        content_hash: string | null;
      }>
    ).map((r) => [r.chunk_index, r.content_hash]),
  );

  // Only new or changed chunks are written; changed ones lose their old embedding.
  const changed = chunkTexts
    .map((text, i) => ({ text, i, hash: sha256Hex(text) }))
    .filter((c) => existingHash.get(c.i) !== c.hash)
    .map((c) => ({
      site_id: siteId,
      asset_id: asset.id,
      chunk_index: c.i,
      text_en: c.text,
      text_original: null,
      language: c.i === 0 ? "en" : asset.language_detected,
      ocr_confidence: c.i === 0 ? null : asset.ocr_confidence,
      content_hash: c.hash,
      embedding: null,
      embedding_model: null,
    }));

  if (changed.length > 0) {
    const { error: chunkErr } = await db
      .from("doc_chunks")
      .upsert(changed, { onConflict: "asset_id,chunk_index" });
    if (chunkErr) throw new Error(`Could not save chunks: ${chunkErr.message}`);
  }
  const { error: staleErr } = await db
    .from("doc_chunks")
    .delete()
    .eq("asset_id", asset.id)
    .gte("chunk_index", chunkTexts.length);
  if (staleErr)
    throw new Error(`Could not remove stale chunks: ${staleErr.message}`);

  /* ---- asset and job ---- */
  const provider = run.providers.join("+");
  const model = run.models.join("+");
  const extracted = {
    ...Object.fromEntries(Object.entries(f).filter(([k]) => k !== "text_en")),
    name_final: nameEn,
    field_confidence: conf,
    uncertain_fields: uncertainFields,
    extraction_confidence: extractionConfidence,
    metadata_based_on_chars: run.metadataBasedOnChars,
    truncated: run.truncated,
  };

  const { error: assetErr } = await db
    .from("assets")
    .update({
      text_en: textEn || null,
      extracted,
      extract_provider: provider,
      extract_model: model,
      site_id: siteId,
    })
    .eq("id", asset.id);
  if (assetErr)
    throw new Error(`Could not save the extraction: ${assetErr.message}`);

  const { error: jobErr } = await db
    .from("jobs")
    .update({ site_id: siteId })
    .eq("id", job.id);
  if (jobErr)
    throw new Error(`Could not link the job to the site: ${jobErr.message}`);

  return {
    output: {
      siteId,
      name: nameEn,
      type: f.type,
      uncertain_fields: uncertainFields,
      extraction_confidence: extractionConfidence,
      chunks: chunkTexts.length,
      chunksTotal: run.chunksTotal,
      chunksTranslated: run.chunksTranslated,
      truncated: run.truncated,
      metadataBasedOnChars: run.metadataBasedOnChars,
      calls: run.calls,
    },
    provider,
    model,
  };
};
