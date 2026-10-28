import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import { runExtractLLM } from "@/lib/stages/extract";

// No route segment config: cacheComponents rejects `dynamic`, `revalidate`, etc.

const BodySchema = z
  .object({
    text: z.string().max(60000).optional(),
    textFile: z.string().max(120).optional(), // a .txt file inside seed/samples/
    language: z.string().max(10).optional(),
    title: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    visualDescription: z.string().max(1000).optional(),
    skipCache: z.boolean().optional(),
  })
  .refine((b) => b.text !== undefined || b.textFile !== undefined, {
    message: "Provide text or textFile",
  });

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, error: "Dev route disabled in production" },
      { status: 404 },
    );
  }
  const raw: unknown = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;

  let text = body.text ?? "";
  if (body.textFile) {
    const name = path.basename(body.textFile);
    try {
      text = await readFile(
        path.join(process.cwd(), "seed", "samples", name),
        "utf8",
      );
    } catch {
      return NextResponse.json(
        { ok: false, error: `File not found: seed/samples/${name}` },
        { status: 404 },
      );
    }
  }

  const t0 = Date.now();
  try {
    const r = await runExtractLLM({
      text,
      language: body.language,
      title: body.title,
      notes: body.notes,
      visualDescription: body.visualDescription,
      skipCache: body.skipCache,
    });
    return NextResponse.json({
      ok: true,
      totalMs: Date.now() - t0,
      chunksTotal: r.chunksTotal,
      chunksTranslated: r.chunksTranslated,
      truncated: r.truncated,
      metadataBasedOnChars: r.metadataBasedOnChars,
      providers: r.providers,
      calls: r.calls,
      fields: { ...r.fields, text_en: undefined },
      textEnChars: r.textEn.length,
      textEn: r.textEn.slice(0, 3000),
    });
  } catch (err) {
    console.error("[api/dev/extract-test]", err);
    return NextResponse.json(
      { ok: false, totalMs: Date.now() - t0, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
