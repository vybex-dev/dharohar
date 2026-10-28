import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import { runOcr } from "@/lib/stages/ocr";

// No route segment config: cacheComponents rejects `dynamic`, `revalidate`, etc.

const BodySchema = z.object({
  file: z.string().min(1).max(120), // a file name inside seed/samples/
  kind: z.enum(["photo", "scan"]).optional(),
  skipCache: z.boolean().optional(),
  forceFallback: z.boolean().optional(),
});

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

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

  const name = path.basename(body.file); // no directory traversal
  const mimeType = MIME_BY_EXT[path.extname(name).toLowerCase()];
  if (!mimeType) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unsupported extension. Use ${Object.keys(MIME_BY_EXT).join(", ")}`,
      },
      { status: 400 },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      await readFile(path.join(process.cwd(), "seed", "samples", name)),
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: `File not found: seed/samples/${name}` },
      { status: 404 },
    );
  }

  const t0 = Date.now();
  try {
    const r = await runOcr({
      bytes,
      mimeType,
      kind: body.kind,
      skipCache: body.skipCache,
      forceFallback: body.forceFallback,
    });
    return NextResponse.json({
      ok: true,
      totalMs: Date.now() - t0,
      language: r.language,
      confidence: r.confidence,
      usedFallback: r.usedFallback,
      providers: r.providers,
      models: r.models,
      preprocess: r.preprocess,
      totalPages: r.totalPages,
      pagesProcessed: r.pagesProcessed,
      truncated: r.truncated,
      visualDescription: r.visualDescription,
      chunks: r.chunks,
      chars: r.text.length,
      text: r.text.slice(0, 3000),
    });
  } catch (err) {
    console.error("[api/dev/ocr-test]", err);
    return NextResponse.json(
      { ok: false, totalMs: Date.now() - t0, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
