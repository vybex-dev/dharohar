import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase-server";
import { getBrowserSupabase } from "@/lib/supabase";

// No route segment config: cacheComponents rejects `dynamic`, `revalidate`, etc.

const SLUG = "dev-test-site";

const BodySchema = z.object({
  name: z.string().min(1).max(200).default("Dharohar Dev Test Site"),
  lat: z.number().min(-90).max(90).default(23.0225),
  lng: z.number().min(-180).max(180).default(72.5714),
  keep: z.boolean().default(false),
});

type GeoRow = {
  id: string;
  slug: string;
  name_en: string;
  status: string;
  lat: number | null;
  lng: number | null;
};

type Check = { name: string; pass: boolean; detail?: string };

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, error: "Dev route disabled in production" },
      { status: 404 },
    );
  }

  const raw: unknown = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { name, lat, lng, keep } = parsed.data;

  const checks: Check[] = [];
  const record = (n: string, pass: boolean, detail?: string) =>
    checks.push({ name: n, pass, detail });

  let admin: ReturnType<typeof getServerSupabase>;
  let anon: ReturnType<typeof getBrowserSupabase>;
  try {
    admin = getServerSupabase();
    anon = getBrowserSupabase();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Client init failed",
      },
      { status: 500 },
    );
  }

  try {
    // 1. Idempotent upsert as DRAFT. Note: EWKT is POINT(lng lat), longitude first.
    const { error: upErr } = await admin.from("sites").upsert(
      {
        slug: SLUG,
        name_en: name,
        category: "other",
        state: "Gujarat",
        summary_en: "Temporary row created by /api/dev/site-test.",
        location: `SRID=4326;POINT(${lng} ${lat})`,
        location_source: "manual",
        location_confidence: 1,
        origin: "upload",
        status: "draft",
      },
      { onConflict: "slug" },
    );
    record("service role upsert (draft)", !upErr, upErr?.message);
    if (upErr) throw new Error(`Upsert failed: ${upErr.message}`);

    // 2. Read back with coordinates via the view
    const { data: adminRows, error: readErr } = await admin
      .from("sites_geo")
      .select("id, slug, name_en, status, lat, lng")
      .eq("slug", SLUG);
    const adminRow = ((adminRows ?? []) as GeoRow[])[0];
    const coordsOk =
      !!adminRow &&
      adminRow.lat !== null &&
      adminRow.lng !== null &&
      Math.abs(adminRow.lat - lat) < 1e-6 &&
      Math.abs(adminRow.lng - lng) < 1e-6;
    record(
      "service role reads lat/lng back",
      !readErr && coordsOk,
      readErr?.message ?? JSON.stringify(adminRow),
    );

    // 3. Anon must NOT see the draft
    const { data: anonDraft, error: anonDraftErr } = await anon
      .from("sites_geo")
      .select("id")
      .eq("slug", SLUG);
    record(
      "anon cannot see draft site",
      !anonDraftErr && (anonDraft ?? []).length === 0,
      anonDraftErr?.message ?? `rows: ${(anonDraft ?? []).length}`,
    );

    // 4. Publish, then anon CAN see it with coordinates
    const { error: pubErr } = await admin
      .from("sites")
      .update({ status: "published" })
      .eq("slug", SLUG);
    record("service role publishes", !pubErr, pubErr?.message);

    const { data: anonPub, error: anonPubErr } = await anon
      .from("sites_geo")
      .select("id, slug, status, lat, lng")
      .eq("slug", SLUG);
    const anonRow = ((anonPub ?? []) as GeoRow[])[0];
    record(
      "anon sees published site with coordinates",
      !anonPubErr && !!anonRow && anonRow.lat !== null && anonRow.lng !== null,
      anonPubErr?.message ?? JSON.stringify(anonRow),
    );

    // 5. Anon writes must be refused
    const { error: anonWriteErr } = await anon
      .from("sites")
      .insert({ slug: "anon-should-fail", name_en: "nope" });
    record(
      "anon insert is refused",
      !!anonWriteErr,
      anonWriteErr?.message ?? "UNEXPECTED: anon insert succeeded",
    );
  } catch (err) {
    record(
      "unexpected error",
      false,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (!keep) {
      const { error: delErr } = await admin
        .from("sites")
        .delete()
        .eq("slug", SLUG);
      record("cleanup (delete test row)", !delErr, delErr?.message);
    }
  }

  const ok = checks.every((c) => c.pass);
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 500 });
}
