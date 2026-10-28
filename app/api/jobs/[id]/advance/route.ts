// app/api/jobs/[id]/advance/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import { JOB_COLUMNS, jobView } from "@/lib/jobs";
import type { RunnableStage } from "@/lib/pipeline";
import { STAGE_HANDLERS } from "@/lib/stages";
import type { AssetRow, JobRow } from "@/lib/stages/types";
import { getServerSupabase } from "@/lib/supabase-server";

// OCR can use OCR_STAGE_BUDGET_MS (default 20 s) plus a possible Tesseract fallback
// (OCR_TESSERACT_TIMEOUT_MS, default 20 s). VERIFY the maximum duration your Vercel
// plan allows. If it is lower than 60, lower this value AND those two env vars.
export const maxDuration = 60;

const ParamsSchema = z.object({ id: z.string().uuid() });

const ASSET_COLUMNS =
  "id, site_id, kind, storage_bucket, storage_path, original_filename, mime_type, size_bytes, title, notes, content_hash, language_detected, ocr_text, ocr_confidence, text_en";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const parsedParams = ParamsSchema.safeParse(await ctx.params);
  if (!parsedParams.success) return badRequest(parsedParams.error);
  const { id } = parsedParams.data;

  try {
    const db = getServerSupabase();

    // 1. Load current state
    const { data: currentData, error: loadErr } = await db
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw new Error(`Could not load job: ${loadErr.message}`);
    const current = currentData as JobRow | null;
    if (!current) {
      return NextResponse.json(
        { ok: false, error: "Job not found" },
        { status: 404 },
      );
    }

    // Already finished: nothing to do. Safe to call forever — and safe to resume
    // after a page reload, since we re-report whether the site actually made it
    // onto the map (embed.ts can finish a job without publishing; see below).
    if (current.stage === "published" && current.status === "done") {
      let output: Record<string, unknown> | undefined;
      if (current.site_id) {
        const { data: siteData } = await db
          .from("sites")
          .select("status, needs_manual_location")
          .eq("id", current.site_id)
          .maybeSingle();
        const site = siteData as {
          status: string;
          needs_manual_location: boolean;
        } | null;
        if (site) {
          output = {
            published: site.status === "published",
            publishBlockedReason: site.needs_manual_location
              ? "needs a manually placed location before it can be published"
              : null,
          };
        }
      }
      return NextResponse.json({
        ok: true,
        claimed: false,
        ran: null,
        output,
        job: jobView(current),
      });
    }

    // 2. Atomically claim the current stage (compare-and-swap in SQL)
    const { data: claimedRows, error: claimErr } = await db.rpc(
      "claim_job_stage",
      {
        p_job_id: id,
      },
    );
    if (claimErr)
      throw new Error(`Could not claim job stage: ${claimErr.message}`);
    const claimed = (claimedRows as JobRow[] | null)?.[0];

    if (!claimed) {
      const reason =
        current.status === "running"
          ? "Another request is running this stage (its lock expires after 120 seconds)."
          : current.status === "failed" &&
              current.attempts >= current.max_attempts
            ? "Out of attempts. POST /api/jobs/[id]/retry to give it a fresh set of attempts."
            : "Stage not claimable right now.";
      return NextResponse.json({
        ok: true,
        claimed: false,
        ran: null,
        reason,
        job: jobView(current),
      });
    }

    const stage = claimed.stage;
    if (stage === "published") {
      return NextResponse.json({
        ok: true,
        claimed: false,
        ran: null,
        job: jobView(claimed),
      });
    }

    // 3. Run exactly ONE stage
    try {
      const handler = STAGE_HANDLERS[stage as RunnableStage];
      if (!handler)
        throw new Error(`No handler registered for stage "${stage}"`);

      const { data: assetData, error: assetErr } = await db
        .from("assets")
        .select(ASSET_COLUMNS)
        .eq("id", claimed.asset_id)
        .maybeSingle();
      if (assetErr || !assetData) {
        throw new Error(
          `Could not load asset: ${assetErr?.message ?? "not found"}`,
        );
      }

      const result = await handler({
        db,
        job: claimed,
        asset: assetData as AssetRow,
      });

      // 4. Record output (including provider and model) and move to the next stage
      const { data: doneRows, error: doneErr } = await db.rpc(
        "complete_job_stage",
        {
          p_job_id: id,
          p_stage: stage,
          p_output: result.output,
          p_provider: result.provider ?? null,
          p_model: result.model ?? null,
        },
      );
      if (doneErr)
        throw new Error(`Could not complete stage: ${doneErr.message}`);

      const after = (doneRows as JobRow[] | null)?.[0] ?? claimed;
      return NextResponse.json({
        ok: true,
        claimed: true,
        ran: stage,
        provider: result.provider ?? null,
        model: result.model ?? null,
        output: result.output,
        job: jobView(after),
      });
    } catch (stageErr) {
      const message = errorMessage(stageErr);
      console.error(`[advance] job ${id} stage ${stage} failed:`, stageErr);

      const { data: failedRows, error: failErr } = await db.rpc(
        "fail_job_stage",
        {
          p_job_id: id,
          p_stage: stage,
          p_error: message,
        },
      );
      if (failErr)
        console.error("[advance] fail_job_stage errored:", failErr.message);

      const after = (failedRows as JobRow[] | null)?.[0];
      return NextResponse.json({
        ok: true,
        claimed: true,
        ran: stage,
        stageError: message,
        job: jobView(after ?? { ...claimed, status: "failed", error: message }),
      });
    }
  } catch (err) {
    console.error("[advance]", err);
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
