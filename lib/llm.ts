import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/lib/pipeline";
import { getServerSupabase } from "@/lib/supabase-server";

/* =========================================================================
 * Public names and types
 * ========================================================================= */

export const PROVIDERS = ["gemini", "nvidia", "groq"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const TASKS = ["ocr", "extract", "parse_query", "embed"] as const;
export type TaskName = (typeof TASKS)[number];
type StructuredTask = Exclude<TaskName, "embed">;

// Must match the check constraint on sites.category in sql/001_schema.sql
export const SITE_CATEGORIES = [
  "stepwell",
  "fort",
  "temple",
  "palace",
  "haveli",
  "monument",
  "craft",
  "textile",
  "other",
] as const;

export type ImageInput = { base64: string; mimeType: string };
export type OcrInput = { image: ImageInput; hint?: string };
export type ExtractInput = {
  text: string;
  language?: string;
  title?: string;
  notes?: string;
  visualDescription?: string;
};
export type ParseQueryInput = { query: string };
export type EmbedInput = { texts: string[]; purpose: "document" | "query" };
export type CallOptions = {
  /** Ignore cached results; the fresh result overwrites the cache entry. */
  skipCache?: boolean;
};

export type LLMResult<T> = {
  output: T;
  provider: ProviderName;
  model: string;
  latencyMs: number;
  cached: boolean;
};

/* =========================================================================
 * Output schemas (Zod)
 * ========================================================================= */

export const OcrOutputSchema = z.object({
  language: z.string().min(1), // ISO 639-1 such as "hi", "gu", "en", or "mixed"
  text: z.string(), // verbatim transcription, original script
  confidence: z.number().min(0).max(1),
  visual_description: z.string(), // short English description of what the image shows
});
export type OcrOutput = z.infer<typeof OcrOutputSchema>;

const categoryOrOther = z.preprocess((v) => {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "other";
  return (SITE_CATEGORIES as readonly string[]).includes(s) ? s : "other";
}, z.enum(SITE_CATEGORIES));

const categoryOrNull = z.preprocess((v) => {
  const s = typeof v === "string" ? v.toLowerCase().trim() : null;
  return s && (SITE_CATEGORIES as readonly string[]).includes(s) ? s : null;
}, z.enum(SITE_CATEGORIES).nullable());

export const ExtractOutputSchema = z.object({
  text_en: z.string(), // English translation of the input text
  name_en: z.string().nullable(),
  name_local: z.string().nullable(),
  category: categoryOrOther,
  state: z.string().nullable(),
  district: z.string().nullable(),
  place_hint: z.string().nullable(), // string suitable for the geocoder
  period: z.string().nullable(),
  tags: z.array(z.string()).transform((a) => a.slice(0, 12)),
  summary_en: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

export const ParseQueryOutputSchema = z.object({
  semantic_query: z.string().min(1), // the query rewritten in English
  category: categoryOrNull,
  state: z.string().nullable(),
  district: z.string().nullable(),
  near_place: z.string().nullable(),
  language: z.string(),
});
export type ParseQueryOutput = z.infer<typeof ParseQueryOutputSchema>;

export const EmbedOutputSchema = z.object({
  vectors: z.array(z.array(z.number()).length(EMBEDDING_DIMENSIONS)).min(1),
});
export type EmbedOutput = z.infer<typeof EmbedOutputSchema>;

/* =========================================================================
 * Errors
 * ========================================================================= */

type ErrorKind =
  | "rate_limit"
  | "transient"
  | "auth"
  | "bad_request"
  | "invalid_output"
  | "empty"
  | "budget";

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    provider: ProviderName,
    kind: ErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

export type AttemptLog = {
  provider: ProviderName;
  model: string;
  kind: ErrorKind;
  status?: number;
  message: string;
};

/** Missing or invalid env configuration. */
export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigError";
  }
}

/** Every provider in the chain failed. */
export class LLMChainError extends Error {
  readonly task: TaskName;
  readonly attempts: AttemptLog[];

  constructor(task: TaskName, attempts: AttemptLog[]) {
    super(
      `All providers failed for task "${task}": ` +
        attempts
          .map(
            (a) =>
              `${a.provider}/${a.model} [${a.kind}${a.status ? ` ${a.status}` : ""}] ${a.message}`,
          )
          .join(" | "),
    );
    this.name = "LLMChainError";
    this.task = task;
    this.attempts = attempts;
  }
}

/* =========================================================================
 * Config (all model IDs, keys and URLs come from env vars)
 * ========================================================================= */

// Env var suffix per task. Matches .env.example: GEMINI_MODEL_OCR, GROQ_MODEL_QUERY_PARSE, ...
const TASK_ENV_SUFFIX: Record<TaskName, string> = {
  ocr: "OCR",
  extract: "EXTRACT",
  parse_query: "QUERY_PARSE",
  embed: "EMBED",
};

const DEFAULT_CHAINS: Record<StructuredTask, ProviderName[]> = {
  ocr: ["gemini", "nvidia", "groq"],
  extract: ["nvidia", "groq", "gemini"],
  parse_query: ["groq", "nvidia", "gemini"],
};

// VERIFY against Google's current docs; override with GEMINI_BASE_URL.
const GEMINI_DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

// Design choices of mine, not provider limits. All overridable via env.
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_TOTAL_BUDGET_MS = 25_000;
const MIN_ATTEMPT_MS = 1_500;
const MAX_BACKOFF_MS = 4_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 60_000;
const MAX_EXTRACT_CHARS = 12_000;
const CACHE_SALT = "v1";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type ProviderConfig = {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  jsonMode: boolean;
};

function resolveProvider(
  provider: ProviderName,
  task: TaskName,
): { config?: ProviderConfig; missing: string[] } {
  const P = provider.toUpperCase();
  const keyVar = `${P}_API_KEY`;
  const modelVar = `${P}_MODEL_${TASK_ENV_SUFFIX[task]}`;
  const baseVar = `${P}_BASE_URL`;

  const apiKey = env(keyVar);
  const model = env(modelVar);
  const baseUrl =
    provider === "gemini"
      ? (env(baseVar) ?? GEMINI_DEFAULT_BASE_URL)
      : env(baseVar);

  const missing: string[] = [];
  if (!apiKey) missing.push(keyVar);
  if (!model) missing.push(modelVar);
  if (!baseUrl) missing.push(baseVar);
  if (missing.length > 0 || !apiKey || !model || !baseUrl) return { missing };

  return {
    config: {
      provider,
      model,
      apiKey,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      jsonMode: env(`${P}_JSON_MODE`) !== "false",
    },
    missing: [],
  };
}

function parseChain(task: StructuredTask): ProviderName[] {
  const varName = `LLM_CHAIN_${TASK_ENV_SUFFIX[task]}`;
  const raw = env(varName);
  if (!raw) return DEFAULT_CHAINS[task];

  const names: ProviderName[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (part === "") continue;
    if (!(PROVIDERS as readonly string[]).includes(part)) {
      throw new LLMConfigError(
        `${varName} contains unknown provider "${part}". Allowed: ${PROVIDERS.join(", ")}`,
      );
    }
    if (!names.includes(part as ProviderName)) names.push(part as ProviderName);
  }
  if (names.length === 0) throw new LLMConfigError(`${varName} is empty`);
  return names;
}

/** Secret-free summary of which providers are usable per task (for the dev route). */
export function describeLLMConfig() {
  return TASKS.map((task) => {
    let chain: ProviderName[];
    try {
      chain = task === "embed" ? ["gemini"] : parseChain(task);
    } catch (e) {
      return { task, error: e instanceof Error ? e.message : String(e) };
    }
    return {
      task,
      fixedProvider: task === "embed",
      chain: chain.map((provider) => {
        const r = resolveProvider(provider, task);
        return {
          provider,
          model: r.config?.model ?? null,
          ready: !!r.config,
          missing: r.missing,
        };
      }),
    };
  });
}

/** The one embedding model ID. Store it in doc_chunks.embedding_model. */
export function embeddingModelId(): string {
  const id = env("GEMINI_MODEL_EMBED");
  if (!id) throw new LLMConfigError("GEMINI_MODEL_EMBED is not set");
  return id;
}

/* =========================================================================
 * Small utilities
 * ========================================================================= */

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function cacheKey(parts: Record<string, unknown>): string {
  return sha256(JSON.stringify({ salt: CACHE_SALT, ...parts }));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: delay is in [ceiling/2, ceiling]. */
function backoffMs(failureCount: number): number {
  const base = envInt("LLM_BACKOFF_BASE_MS", 500);
  const ceiling = Math.min(MAX_BACKOFF_MS, base * 2 ** (failureCount - 1));
  return Math.floor(ceiling / 2 + (Math.random() * ceiling) / 2);
}

function log(evt: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt: "llm", ...evt }));
}

function warn(evt: Record<string, unknown>): void {
  console.warn(JSON.stringify({ evt: "llm_warn", ...evt }));
}

/* =========================================================================
 * Prompts
 * ========================================================================= */

type BuiltRequest = { system: string; user: string; image?: ImageInput };

function buildOcr(input: OcrInput): BuiltRequest {
  return {
    system: [
      "You are an OCR engine for scanned and photographed heritage material: inscriptions, archival records, signboards, letters and printed pages.",
      "The text may be in Devanagari (Hindi, Marathi, Sanskrit), Gujarati or English, often mixed, and may be faded or handwritten.",
      "Transcribe exactly what is written, keeping line breaks and the original script. Do not translate, summarise or correct spelling.",
      "Mark unreadable parts as [illegible]. If the image contains no text, return an empty string for text.",
      "Reply with a single JSON object and nothing else, with these keys:",
      '"language": dominant language as an ISO 639-1 code such as "hi", "gu", "en", or "mixed";',
      '"text": the transcription;',
      '"confidence": a number from 0 to 1 for how reliable the transcription is;',
      '"visual_description": one or two English sentences describing what the image shows (type of building, object or document).',
    ].join("\n"),
    user: input.hint
      ? `Transcribe this image. Context: ${input.hint}`
      : "Transcribe this image.",
    image: input.image,
  };
}

function buildExtract(input: ExtractInput): BuiltRequest {
  const text = truncate(input.text, MAX_EXTRACT_CHARS);
  const sections = [
    `OCR TEXT${input.language ? ` (language: ${input.language})` : ""}:\n${text}`,
    input.title ? `USER TITLE: ${input.title}` : null,
    input.notes ? `USER NOTES: ${input.notes}` : null,
    input.visualDescription
      ? `IMAGE DESCRIPTION: ${input.visualDescription}`
      : null,
  ].filter((s): s is string => s !== null);

  return {
    system: [
      "You extract structured records about Indian cultural and architectural heritage from OCR text, which may be in Hindi, Gujarati, English or a mix.",
      "Use only facts present in the input. Use null when something is unknown. Never invent names, dates or places.",
      "Reply with a single JSON object and nothing else, with these keys:",
      '"text_en": a faithful English translation of the OCR text (copy it unchanged if already English);',
      '"name_en": the English name of the site, object or craft, or null;',
      '"name_local": the name in its original script, or null;',
      `"category": one of ${SITE_CATEGORIES.join(", ")};`,
      '"state": Indian state in English, or null;',
      '"district": district in English, or null;',
      '"place_hint": a short string for a geocoder such as "Rani ki Vav, Patan, Gujarat, India", or null if no place can be identified;',
      '"period": era or date range as stated, or null;',
      '"tags": up to 12 short lowercase English keywords;',
      '"summary_en": two to four English sentences summarising the record;',
      '"confidence": a number from 0 to 1 for how reliable this extraction is.',
    ].join("\n"),
    user: sections.join("\n\n"),
  };
}

function buildParseQuery(input: ParseQueryInput): BuiltRequest {
  return {
    system: [
      "You turn a visitor's search query about Indian cultural heritage, written in any language, into structured search parameters for a database of English-language heritage records.",
      "Never invent filters that the query does not imply.",
      "Reply with a single JSON object and nothing else, with these keys:",
      '"semantic_query": the query rewritten in English, keeping meaningful descriptive words and dropping filler;',
      `"category": one of ${SITE_CATEGORIES.join(", ")}, or null unless the query clearly names a type;`,
      '"state": Indian state in English, or null;',
      '"district": district in English, or null;',
      '"near_place": a named place the user wants results near, or null;',
      '"language": ISO 639-1 code of the original query.',
    ].join("\n"),
    user: `Query: ${input.query}`,
  };
}

/* =========================================================================
 * HTTP and provider calls
 * ========================================================================= */

type ChatRequest = {
  system: string;
  user: string;
  image?: ImageInput;
  repair?: { previous: string; error: string };
};

function repairInstruction(error: string): string {
  return (
    `Your previous reply was not acceptable: ${error}. ` +
    "Reply again with ONLY one valid JSON object containing exactly the requested keys. No markdown, no commentary."
  );
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

async function httpError(
  provider: ProviderName,
  res: Response,
): Promise<ProviderError> {
  const body = truncate(await res.text().catch(() => ""), 300);
  const status = res.status;
  const kind: ErrorKind =
    status === 429
      ? "rate_limit"
      : status === 408 || status >= 500
        ? "transient"
        : status === 401 || status === 403
          ? "auth"
          : "bad_request";
  return new ProviderError(provider, kind, `HTTP ${status}: ${body}`, {
    status,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
  });
}

function toProviderError(provider: ProviderName, e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      return new ProviderError(
        provider,
        "transient",
        `Request timed out (${e.message})`,
      );
    }
    return new ProviderError(
      provider,
      "transient",
      `Request failed: ${e.message}`,
    );
  }
  return new ProviderError(
    provider,
    "transient",
    `Unknown error: ${String(e)}`,
  );
}

const GeminiGenerateResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

const ChatCompletionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const GeminiBatchEmbedResponse = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
});

function geminiModelPath(model: string): string {
  return encodeURIComponent(model.replace(/^models\//, ""));
}

async function callGemini(
  c: ProviderConfig,
  req: ChatRequest,
  timeoutMs: number,
): Promise<string> {
  const userParts: Array<Record<string, unknown>> = [{ text: req.user }];
  if (req.image) {
    userParts.push({
      inlineData: { mimeType: req.image.mimeType, data: req.image.base64 },
    });
  }
  const contents: Array<Record<string, unknown>> = [
    { role: "user", parts: userParts },
  ];
  if (req.repair) {
    contents.push({ role: "model", parts: [{ text: req.repair.previous }] });
    contents.push({
      role: "user",
      parts: [{ text: repairInstruction(req.repair.error) }],
    });
  }

  const generationConfig: Record<string, unknown> = { temperature: 0 };
  if (c.jsonMode) generationConfig.responseMimeType = "application/json";
  const maxTokens = envInt("LLM_MAX_OUTPUT_TOKENS", 0);
  if (maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;

  const res = await fetch(
    `${c.baseUrl}/models/${geminiModelPath(c.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": c.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents,
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) throw await httpError(c.provider, res);

  const parsed = GeminiGenerateResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new ProviderError(
      c.provider,
      "empty",
      "Unexpected Gemini response shape",
    );
  }
  const candidate = parsed.data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => p.thought !== true)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    const why =
      parsed.data.promptFeedback?.blockReason ??
      candidate?.finishReason ??
      "no text";
    throw new ProviderError(
      c.provider,
      "empty",
      `Gemini returned no text (${why})`,
    );
  }
  return text;
}

async function callOpenAICompat(
  c: ProviderConfig,
  req: ChatRequest,
  timeoutMs: number,
  jsonMode: boolean,
): Promise<string> {
  const userContent = req.image
    ? [
        { type: "text", text: req.user },
        {
          type: "image_url",
          image_url: {
            url: `data:${req.image.mimeType};base64,${req.image.base64}`,
          },
        },
      ]
    : req.user;

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: req.system },
    { role: "user", content: userContent },
  ];
  if (req.repair) {
    messages.push({ role: "assistant", content: req.repair.previous });
    messages.push({
      role: "user",
      content: repairInstruction(req.repair.error),
    });
  }

  const body: Record<string, unknown> = {
    model: c.model,
    messages,
    temperature: 0,
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const maxTokens = envInt("LLM_MAX_OUTPUT_TOKENS", 0);
  if (maxTokens > 0) body.max_tokens = maxTokens;

  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${c.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const err = await httpError(c.provider, res);
    // Some models reject response_format. Retry once without it.
    if (
      jsonMode &&
      res.status === 400 &&
      /response_format|json_object|json mode/i.test(err.message)
    ) {
      warn({
        provider: c.provider,
        model: c.model,
        note: "JSON mode rejected, retrying without it",
      });
      return callOpenAICompat(c, req, timeoutMs, false);
    }
    throw err;
  }

  const parsed = ChatCompletionResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new ProviderError(
      c.provider,
      "empty",
      "Unexpected chat completion response shape",
    );
  }
  const text = (parsed.data.choices[0]?.message.content ?? "").trim();
  if (!text)
    throw new ProviderError(
      c.provider,
      "empty",
      "Provider returned empty content",
    );
  return text;
}

function callChat(
  c: ProviderConfig,
  req: ChatRequest,
  timeoutMs: number,
): Promise<string> {
  return c.provider === "gemini"
    ? callGemini(c, req, timeoutMs)
    : callOpenAICompat(c, req, timeoutMs, c.jsonMode);
}

/* =========================================================================
 * JSON parsing and validation
 * ========================================================================= */

function extractJson(text: string): unknown {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseAndValidate<S extends z.ZodType>(
  text: string,
  schema: S,
): Parsed<z.infer<S>> {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (e) {
    return {
      ok: false,
      error: `not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  const detail = r.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `JSON did not match the schema (${detail})` };
}

/* =========================================================================
 * Retry, cooldown and cache
 * ========================================================================= */

// Best-effort and per server instance: skip a rate-limited provider for a while.
const cooldownUntil = new Map<ProviderName, number>();

function setCooldown(provider: ProviderName, retryAfterMs?: number): void {
  const ms = Math.min(retryAfterMs ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  cooldownUntil.set(provider, Date.now() + ms);
}

function orderByCooldown<T extends { provider: ProviderName }>(
  items: T[],
): T[] {
  const now = Date.now();
  const ready = items.filter(
    (c) => (cooldownUntil.get(c.provider) ?? 0) <= now,
  );
  const cooling = items.filter(
    (c) => (cooldownUntil.get(c.provider) ?? 0) > now,
  );
  return [...ready, ...cooling]; // cooling providers are tried last, not skipped
}

/** Retries transient failures with backoff. Never retries 429 (caller moves to the next provider). */
async function withRetries<T>(
  provider: ProviderName,
  deadline: number,
  fn: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, envInt("LLM_MAX_ATTEMPTS", 2));
  let failures = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      throw new ProviderError(provider, "budget", "Time budget exhausted");
    }
    try {
      return await fn(
        Math.min(envInt("LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), remaining),
      );
    } catch (e) {
      const pe = toProviderError(provider, e);
      if (pe.kind === "rate_limit") setCooldown(provider, pe.retryAfterMs);
      if (pe.kind === "transient") {
        failures += 1;
        if (failures < maxAttempts) {
          const delay = backoffMs(failures);
          if (deadline - Date.now() > delay + MIN_ATTEMPT_MS) {
            await sleep(delay);
            continue;
          }
        }
      }
      throw pe;
    }
  }
}

type Candidate = ProviderConfig & { key: string };

async function cacheGet<S extends z.ZodType>(
  cands: Candidate[],
  schema: S,
): Promise<{ cand: Candidate; output: z.infer<S> } | null> {
  try {
    const { data, error } = await getServerSupabase()
      .from("llm_cache")
      .select("key, output")
      .in(
        "key",
        cands.map((c) => c.key),
      );
    if (error) {
      warn({ where: "cache_get", message: error.message });
      return null;
    }
    const byKey = new Map<string, unknown>();
    for (const row of (data ?? []) as Array<{ key: string; output: unknown }>) {
      byKey.set(row.key, row.output);
    }
    for (const cand of cands) {
      if (!byKey.has(cand.key)) continue;
      const p = schema.safeParse(byKey.get(cand.key));
      if (p.success) return { cand, output: p.data }; // stale or invalid rows are ignored
    }
    return null;
  } catch (e) {
    warn({
      where: "cache_get",
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function cacheSet(
  task: TaskName,
  cand: Candidate,
  output: unknown,
  overwrite: boolean,
): Promise<void> {
  try {
    const { error } = await getServerSupabase()
      .from("llm_cache")
      .upsert(
        {
          key: cand.key,
          task,
          provider: cand.provider,
          model: cand.model,
          output,
        },
        { onConflict: "key", ignoreDuplicates: !overwrite },
      );
    if (error) warn({ where: "cache_set", message: error.message });
  } catch (e) {
    warn({
      where: "cache_set",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/* =========================================================================
 * Structured tasks (ocr, extract, parse_query)
 * ========================================================================= */

function resolveChain(
  task: StructuredTask,
  built: BuiltRequest,
): ProviderConfig[] {
  const usable: ProviderConfig[] = [];
  const problems: string[] = [];

  for (const name of parseChain(task)) {
    if (built.image?.mimeType === "application/pdf" && name !== "gemini") {
      problems.push(`${name}: PDF input is only sent to gemini`);
      continue;
    }
    const r = resolveProvider(name, task);
    if (r.config) usable.push(r.config);
    else problems.push(`${name}: missing ${r.missing.join(", ")}`);
  }

  if (usable.length === 0) {
    throw new LLMConfigError(
      `No usable provider for task "${task}". ${problems.join(" | ")}`,
    );
  }
  if (problems.length > 0) warn({ task, skipped: problems });
  return usable;
}

/** One provider, one logical attempt: call, validate, and repair once if the JSON is bad. */
async function structuredOnce<S extends z.ZodType>(
  c: ProviderConfig,
  built: BuiltRequest,
  schema: S,
  deadline: number,
  timeoutMs: number,
): Promise<z.infer<S>> {
  const first = await callChat(c, built, timeoutMs);
  const p1 = parseAndValidate(first, schema);
  if (p1.ok) return p1.value;

  const remaining = deadline - Date.now();
  if (remaining < MIN_ATTEMPT_MS) {
    throw new ProviderError(
      c.provider,
      "invalid_output",
      `Invalid output: ${p1.error}`,
    );
  }

  const second = await callChat(
    c,
    { ...built, repair: { previous: truncate(first, 4000), error: p1.error } },
    Math.min(timeoutMs, remaining),
  );
  const p2 = parseAndValidate(second, schema);
  if (p2.ok) return p2.value;
  throw new ProviderError(
    c.provider,
    "invalid_output",
    `Invalid output after one repair attempt: ${p2.error}`,
  );
}

async function runStructured<S extends z.ZodType>(
  task: StructuredTask,
  built: BuiltRequest,
  schema: S,
  opts: CallOptions,
): Promise<LLMResult<z.infer<S>>> {
  const started = Date.now();
  const chain = resolveChain(task, built);
  const imageSha = built.image ? sha256(built.image.base64) : null;

  const cands: Candidate[] = chain.map((c) => ({
    ...c,
    key: cacheKey({
      task,
      provider: c.provider,
      model: c.model,
      system: built.system,
      user: built.user,
      imageSha,
    }),
  }));

  if (!opts.skipCache) {
    const hit = await cacheGet(cands, schema);
    if (hit) {
      const latencyMs = Date.now() - started;
      log({
        task,
        provider: hit.cand.provider,
        model: hit.cand.model,
        latencyMs,
        cached: true,
      });
      return {
        output: hit.output,
        provider: hit.cand.provider,
        model: hit.cand.model,
        latencyMs,
        cached: true,
      };
    }
  }

  const deadline =
    started + envInt("LLM_TOTAL_BUDGET_MS", DEFAULT_TOTAL_BUDGET_MS);
  const attempts: AttemptLog[] = [];

  for (const cand of orderByCooldown(cands)) {
    const t0 = Date.now();
    try {
      const output = await withRetries(cand.provider, deadline, (timeoutMs) =>
        structuredOnce(cand, built, schema, deadline, timeoutMs),
      );
      await cacheSet(task, cand, output, opts.skipCache === true);
      const latencyMs = Date.now() - started;
      log({
        task,
        provider: cand.provider,
        model: cand.model,
        latencyMs,
        cached: false,
        failedBefore: attempts.length,
      });
      return {
        output,
        provider: cand.provider,
        model: cand.model,
        latencyMs,
        cached: false,
      };
    } catch (e) {
      const pe = toProviderError(cand.provider, e);
      attempts.push({
        provider: cand.provider,
        model: cand.model,
        kind: pe.kind,
        status: pe.status,
        message: pe.message,
      });
      warn({
        task,
        provider: cand.provider,
        model: cand.model,
        kind: pe.kind,
        status: pe.status,
        ms: Date.now() - t0,
        message: pe.message,
      });
      if (pe.kind === "budget") break;
    }
  }

  throw new LLMChainError(task, attempts);
}

/* =========================================================================
 * Embeddings: ONE fixed model, 768 dimensions, no fallback providers
 * ========================================================================= */

function assertEmbeddingDims(): void {
  const raw = env("EMBED_DIMENSIONS");
  if (raw !== undefined && Number(raw) !== EMBEDDING_DIMENSIONS) {
    throw new LLMConfigError(
      `EMBED_DIMENSIONS is ${raw} but the database column is vector(${EMBEDDING_DIMENSIONS}). ` +
        "Change one of them (changing the column means re-embedding everything).",
    );
  }
}

function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => Number((x / norm).toFixed(6))) : v;
}

async function geminiEmbedBatch(
  c: ProviderConfig,
  texts: string[],
  purpose: EmbedInput["purpose"],
  timeoutMs: number,
): Promise<number[][]> {
  const modelPath = c.model.replace(/^models\//, "");
  const res = await fetch(
    `${c.baseUrl}/models/${encodeURIComponent(modelPath)}:batchEmbedContents`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": c.apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${modelPath}`,
          content: { parts: [{ text: t }] },
          taskType:
            purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) throw await httpError(c.provider, res);

  const parsed = GeminiBatchEmbedResponse.safeParse(await res.json());
  if (!parsed.success || parsed.data.embeddings.length !== texts.length) {
    throw new ProviderError(
      c.provider,
      "bad_request",
      `Unexpected embedding response (expected ${texts.length} vectors)`,
    );
  }

  return parsed.data.embeddings.map((e) => {
    if (e.values.length !== EMBEDDING_DIMENSIONS) {
      throw new ProviderError(
        c.provider,
        "bad_request",
        `Model ${c.model} returned ${e.values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
          "Pick a model that supports 768-dimension output.",
      );
    }
    return l2normalize(e.values);
  });
}

async function runEmbed(
  input: EmbedInput,
  opts: CallOptions,
): Promise<LLMResult<EmbedOutput>> {
  const started = Date.now();
  assertEmbeddingDims();

  if (input.texts.length === 0 || input.texts.some((t) => t.trim() === "")) {
    throw new Error(
      "embed: texts must be a non-empty list of non-empty strings",
    );
  }

  const resolved = resolveProvider("gemini", "embed");
  if (!resolved.config) {
    throw new LLMConfigError(
      `Embeddings are not configured. Missing env vars: ${resolved.missing.join(", ")}`,
    );
  }
  const cand: Candidate = {
    ...resolved.config,
    key: cacheKey({
      task: "embed",
      provider: "gemini",
      model: resolved.config.model,
      purpose: input.purpose,
      dims: EMBEDDING_DIMENSIONS,
      texts: input.texts,
    }),
  };

  if (!opts.skipCache) {
    const hit = await cacheGet([cand], EmbedOutputSchema);
    if (hit) {
      const latencyMs = Date.now() - started;
      log({
        task: "embed",
        provider: "gemini",
        model: cand.model,
        latencyMs,
        cached: true,
      });
      return {
        output: hit.output,
        provider: "gemini",
        model: cand.model,
        latencyMs,
        cached: true,
      };
    }
  }

  const deadline =
    started + envInt("LLM_TOTAL_BUDGET_MS", DEFAULT_TOTAL_BUDGET_MS);
  const batchSize = Math.max(1, envInt("EMBED_BATCH_SIZE", 16));

  try {
    const vectors = await withRetries("gemini", deadline, async (timeoutMs) => {
      const out: number[][] = [];
      for (let i = 0; i < input.texts.length; i += batchSize) {
        const remaining = deadline - Date.now();
        if (remaining < MIN_ATTEMPT_MS) {
          throw new ProviderError("gemini", "budget", "Time budget exhausted");
        }
        out.push(
          ...(await geminiEmbedBatch(
            cand,
            input.texts.slice(i, i + batchSize),
            input.purpose,
            Math.min(timeoutMs, remaining),
          )),
        );
      }
      return out;
    });

    const output: EmbedOutput = { vectors };
    await cacheSet("embed", cand, output, opts.skipCache === true);
    const latencyMs = Date.now() - started;
    log({
      task: "embed",
      provider: "gemini",
      model: cand.model,
      latencyMs,
      cached: false,
    });
    return {
      output,
      provider: "gemini",
      model: cand.model,
      latencyMs,
      cached: false,
    };
  } catch (e) {
    const pe = toProviderError("gemini", e);
    throw new LLMChainError("embed", [
      {
        provider: "gemini",
        model: cand.model,
        kind: pe.kind,
        status: pe.status,
        message: pe.message,
      },
    ]);
  }
}

/* =========================================================================
 * Entry point
 * ========================================================================= */

export function callLLM(
  task: "ocr",
  input: OcrInput,
  opts?: CallOptions,
): Promise<LLMResult<OcrOutput>>;
export function callLLM(
  task: "extract",
  input: ExtractInput,
  opts?: CallOptions,
): Promise<LLMResult<ExtractOutput>>;
export function callLLM(
  task: "parse_query",
  input: ParseQueryInput,
  opts?: CallOptions,
): Promise<LLMResult<ParseQueryOutput>>;
export function callLLM(
  task: "embed",
  input: EmbedInput,
  opts?: CallOptions,
): Promise<LLMResult<EmbedOutput>>;
export async function callLLM(
  task: TaskName,
  input: OcrInput | ExtractInput | ParseQueryInput | EmbedInput,
  opts: CallOptions = {},
): Promise<LLMResult<unknown>> {
  switch (task) {
    case "ocr":
      return runStructured(
        "ocr",
        buildOcr(input as OcrInput),
        OcrOutputSchema,
        opts,
      );
    case "extract":
      return runStructured(
        "extract",
        buildExtract(input as ExtractInput),
        ExtractOutputSchema,
        opts,
      );
    case "parse_query":
      return runStructured(
        "parse_query",
        buildParseQuery(input as ParseQueryInput),
        ParseQueryOutputSchema,
        opts,
      );
    case "embed":
      return runEmbed(input as EmbedInput, opts);
  }
}
