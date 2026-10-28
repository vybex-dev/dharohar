// app/api/jobs/[id]/retry/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import { JOB_COLUMNS, jobView } from "@/lib/jobs";
import type { JobRow } from "@/lib/stages/types";
import { getServerSupabase } from "@/lib/supabase-server";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const parsedParams = ParamsSchema.safeParse(await ctx.params);
  if (!parsedParams.success) return badRequest(parsedParams.error);
  const { id } = parsedParams.data;

  try {
    const db = getServerSupabase();

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

    if (current.stage === "published" && current.status === "done") {
      return NextResponse.json(
        {
          ok: false,
          error: "This job already finished; there is nothing to retry.",
          job: jobView(current),
        },
        { status: 400 },
      );
    }

    if (current.status !== "failed") {
      return NextResponse.json(
        {
          ok: false,
          error:
            `Job is "${current.status}", not "failed". ` +
            (current.status === "running"
              ? "Wait for the current attempt to finish (its lock expires after 120 seconds)."
              : "It still has attempts left — call /advance again instead of /retry."),
          job: jobView(current),
        },
        { status: 409 },
      );
    }

    // CAS on status='failed': guards a race with a concurrent advance/retry call
    // for the same job (e.g. two browser tabs).
    const { data: updatedRows, error: updErr } = await db
      .from("jobs")
      .update({ attempts: 0, status: "pending", error: null, locked_at: null })
      .eq("id", id)
      .eq("status", "failed")
      .select(JOB_COLUMNS);
    if (updErr) throw new Error(`Could not reset job: ${updErr.message}`);

    const updated = (updatedRows as JobRow[] | null)?.[0];
    if (!updated) {
      return NextResponse.json(
        {
          ok: false,
          error: "Job state changed before the retry could apply. Try again.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, job: jobView(updated) });
  } catch (err) {
    console.error("[retry]", err);
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
