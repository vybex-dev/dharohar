// app/api/review/[jobId]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import { ReviewError, saveReview } from "@/lib/review";
import type { ReviewSaveResponse } from "@/lib/review-fields";
import { ReviewSaveSchema } from "@/lib/review-schema";

// Re-embedding a handful of chunks is quick, but VERIFY the maximum duration your
// Vercel plan allows (same note as the advance route).
export const maxDuration = 60;

const ParamsSchema = z.object({ jobId: z.string().uuid() });

function fail(error: string, status: number) {
  const body: ReviewSaveResponse = { ok: false, error };
  return NextResponse.json(body, { status });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const parsedParams = ParamsSchema.safeParse(await ctx.params);
  if (!parsedParams.success) return badRequest(parsedParams.error);
  const { jobId } = parsedParams.data;

  // A cross-site form or text/plain fetch can reach this route without a CORS preflight.
  // Requiring a JSON content type closes that door.
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return fail("Content-Type must be application/json", 415);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("Request body is not valid JSON", 400);
  }
  const parsed = ReviewSaveSchema.safeParse(json);
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const { review, indexError, reembedded } = await saveReview(
      jobId,
      parsed.data,
    );
    const body: ReviewSaveResponse = {
      ok: true,
      review,
      indexError,
      reembedded,
    };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof ReviewError) return fail(err.message, err.status);
    console.error("[review]", err);
    return fail(errorMessage(err), 500);
  }
}
