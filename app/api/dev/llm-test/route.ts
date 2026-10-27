import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import {
  callLLM,
  describeLLMConfig,
  LLMChainError,
  LLMConfigError,
} from "@/lib/llm";
import { getServerSupabase } from "@/lib/supabase-server";

// No route segment config: cacheComponents rejects `dynamic`, `revalidate`, etc.

const common = { skipCache: z.boolean().optional() };

const BodySchema = z.discriminatedUnion("task", [
  z.object({
    task: z.literal("parse_query"),
    query: z.string().min(1).max(500),
    ...common,
  }),
  z.object({
    task: z.literal("extract"),
    text: z.string().min(1).max(20000),
    title: z.string().max(200).optional(),
    ...common,
  }),
  z.object({
    task: z.literal("embed"),
    texts: z.array(z.string().min(1).max(5000)).min(1).max(10),
    purpose: z.enum(["document", "query"]).default("document"),
    ...common,
  }),
  // OCR runs on an already-uploaded asset: pass its id
  z.object({ task: z.literal("ocr"), assetId: z.string().uuid(), ...common }),
]);

function prodGuard() {
  return process.env.NODE_ENV === "production"
    ? NextResponse.json(
        { ok: false, error: "Dev route disabled in production" },
        { status: 404 },
      )
    : null;
}

export async function GET() {
  const blocked = prodGuard();
  if (blocked) return blocked;
  return NextResponse.json({ ok: true, config: describeLLMConfig() });
}

export async function POST(req: Request) {
  const blocked = prodGuard();
  if (blocked) return blocked;

  const raw: unknown = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;
  const opts = { skipCache: body.skipCache };

  try {
    switch (body.task) {
      case "parse_query": {
        const r = await callLLM("parse_query", { query: body.query }, opts);
        return NextResponse.json({ ok: true, task: body.task, ...r });
      }

      case "extract": {
        const r = await callLLM(
          "extract",
          { text: body.text, title: body.title },
          opts,
        );
        return NextResponse.json({ ok: true, task: body.task, ...r });
      }

      case "embed": {
        const r = await callLLM(
          "embed",
          { texts: body.texts, purpose: body.purpose },
          opts,
        );
        const first = r.output.vectors[0] ?? [];
        return NextResponse.json({
          ok: true,
          task: body.task,
          provider: r.provider,
          model: r.model,
          latencyMs: r.latencyMs,
          cached: r.cached,
          count: r.output.vectors.length,
          dims: first.length,
          norm: Math.sqrt(first.reduce((s, x) => s + x * x, 0)),
          first3: first.slice(0, 3),
        });
      }

      case "ocr": {
        const db = getServerSupabase();
        const { data: asset, error } = await db
          .from("assets")
          .select("storage_bucket, storage_path, mime_type")
          .eq("id", body.assetId)
          .maybeSingle();
        if (error) throw new Error(`Could not load asset: ${error.message}`);
        if (!asset) {
          return NextResponse.json(
            { ok: false, error: "Asset not found" },
            { status: 404 },
          );
        }
        const a = asset as {
          storage_bucket: string;
          storage_path: string;
          mime_type: string | null;
        };

        const { data: blob, error: dlErr } = await db.storage
          .from(a.storage_bucket)
          .download(a.storage_path);
        if (dlErr || !blob)
          throw new Error(
            `Could not download file: ${dlErr?.message ?? "no data"}`,
          );

        const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
        const r = await callLLM(
          "ocr",
          { image: { base64, mimeType: a.mime_type ?? "image/jpeg" } },
          opts,
        );
        return NextResponse.json({
          ok: true,
          task: body.task,
          provider: r.provider,
          model: r.model,
          latencyMs: r.latencyMs,
          cached: r.cached,
          output: { ...r.output, text: r.output.text.slice(0, 2000) },
        });
      }
    }
  } catch (err) {
    if (err instanceof LLMChainError) {
      return NextResponse.json(
        { ok: false, error: err.message, attempts: err.attempts },
        { status: 502 },
      );
    }
    if (err instanceof LLMConfigError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: 500 },
      );
    }
    console.error("[api/dev/llm-test]", err);
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
