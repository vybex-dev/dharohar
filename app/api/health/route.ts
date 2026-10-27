import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = getServerSupabase();

    const { data: row, error: rowError } = await supabase
      .from("health_check")
      .select("id, note, created_at")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (rowError) {
      return NextResponse.json(
        {
          ok: false,
          stage: "read_row",
          error: rowError.message,
          hint: rowError.hint ?? "Did you run sql/000_health.sql?",
        },
        { status: 500 },
      );
    }

    const { data: extensions, error: extError } =
      await supabase.rpc("health_extensions");

    if (extError) {
      return NextResponse.json(
        { ok: false, stage: "check_extensions", error: extError.message },
        { status: 500 },
      );
    }

    const installed = (extensions as string[] | null) ?? [];
    const missing = ["postgis", "vector"].filter((e) => !installed.includes(e));

    return NextResponse.json({
      ok: missing.length === 0,
      row,
      extensions: installed,
      missingExtensions: missing,
      time: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { ok: false, stage: "server", error: message },
      { status: 500 },
    );
  }
}
