import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage } from "@/lib/http";
import { getServerSupabase } from "@/lib/supabase-server";

export type JourneySiteStop = {
  id: string;
  slug: string;
  name: string;
  category: string;
  lat: number | null;
  lng: number | null;
  thumbnail: string | null;
};

export type JourneyDto = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  era: string | null;
  tags: string[];
  color: string;
  distanceKm: number;
  siteIds: string[];
  stops: JourneySiteStop[];
  routeGeojson: {
    type: "LineString";
    coordinates: [number, number][];
  };
  createdAt: string;
};

const CreateJourneySchema = z.object({
  title: z.string().trim().min(3).max(150),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(150)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().trim().max(2000).optional(),
  era: z.string().trim().max(100).optional(),
  tags: z.array(z.string().trim().max(50)).default([]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a 6-digit hex code")
    .default("#b45309"),
  coordinates: z
    .array(
      z.tuple([
        z.number().min(-180).max(180), // lng
        z.number().min(-90).max(90),   // lat
      ]),
    )
    .min(2, "A journey route must contain at least 2 points"),
  siteIds: z.array(z.string().uuid()).default([]),
});

export async function GET() {
  try {
    const db = getServerSupabase();

    // 1. Fetch journeys with their GeoJSON route representation
    const { data: journeysData, error: jErr } = await db
      .from("journeys_geo")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (jErr) {
      // If table doesn't exist yet, return empty list safely
      console.warn("[journeys GET] journeys_geo query note:", jErr.message);
      return NextResponse.json({ ok: true, journeys: [] });
    }

    const rows = journeysData ?? [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, journeys: [] });
    }

    // 2. Collect all site_ids referenced across all journeys
    const allSiteIds = Array.from(
      new Set(rows.flatMap((r) => (r.site_ids ?? []) as string[])),
    );

    const siteMap = new Map<string, JourneySiteStop>();

    if (allSiteIds.length > 0) {
      const [{ data: sitesData }, { data: geoData }, { data: thumbData }] =
        await Promise.all([
          db
            .from("sites")
            .select("id, slug, name_en, category")
            .in("id", allSiteIds),
          db.from("sites_geo").select("id, lat, lng").in("id", allSiteIds),
          db
            .from("assets")
            .select("site_id, storage_bucket, storage_path")
            .in("site_id", allSiteIds)
            .eq("kind", "photo")
            .order("created_at", { ascending: true }),
        ]);

      const geoById = new Map(
        (geoData ?? []).map((g) => [g.id, { lat: g.lat, lng: g.lng }]),
      );

      // Sign thumbnails if any
      const thumbBySite = new Map<string, string>();
      if (thumbData && thumbData.length > 0) {
        const seen = new Set<string>();
        const toSign: { bucket: string; path: string; siteId: string }[] = [];
        for (const t of thumbData) {
          if (!t.site_id || seen.has(t.site_id)) continue;
          seen.add(t.site_id);
          toSign.push({
            bucket: t.storage_bucket,
            path: t.storage_path,
            siteId: t.site_id,
          });
        }
        for (const item of toSign) {
          const { data: sData } = await db.storage
            .from(item.bucket)
            .createSignedUrl(item.path, 3600);
          if (sData?.signedUrl) {
            thumbBySite.set(item.siteId, sData.signedUrl);
          }
        }
      }

      for (const s of sitesData ?? []) {
        const coords = geoById.get(s.id);
        siteMap.set(s.id, {
          id: s.id,
          slug: s.slug,
          name: s.name_en,
          category: s.category,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          thumbnail: thumbBySite.get(s.id) ?? null,
        });
      }
    }

    const journeys: JourneyDto[] = rows.map((r) => {
      const orderedStops: JourneySiteStop[] = ((r.site_ids ?? []) as string[])
        .map((id) => siteMap.get(id))
        .filter((s): s is JourneySiteStop => Boolean(s));

      return {
        id: r.id,
        slug: r.slug,
        title: r.title,
        description: r.description ?? null,
        era: r.era ?? null,
        tags: r.tags ?? [],
        color: r.color ?? "#b45309",
        distanceKm: Number(r.distance_km ?? 0),
        siteIds: r.site_ids ?? [],
        stops: orderedStops,
        routeGeojson: r.route_geojson,
        createdAt: r.created_at,
      };
    });

    return NextResponse.json({ ok: true, journeys });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const raw: unknown = await req.json().catch(() => null);
  if (raw === null) {
    return NextResponse.json(
      { ok: false, error: "Body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = CreateJourneySchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;

  try {
    const db = getServerSupabase();

    // Construct PostGIS LINESTRING EWKT: SRID=4326;LINESTRING(lng lat, lng lat, ...)
    const lineCoordStrings = body.coordinates
      .map(([lng, lat]) => `${lng} ${lat}`)
      .join(", ");
    const ewkt = `SRID=4326;LINESTRING(${lineCoordStrings})`;

    const { data, error } = await db
      .from("journeys")
      .upsert(
        {
          slug: body.slug,
          title: body.title,
          title_en: body.title,
          description: body.description ?? null,
          description_en: body.description ?? null,
          era: body.era ?? null,
          tags: body.tags,
          color: body.color,
          route: ewkt,
          site_ids: body.siteIds,
          status: "published",
        },
        { onConflict: "slug" },
      )
      .select("id, slug, title")
      .single();

    if (error) {
      throw new Error(`Could not save journey: ${error.message}`);
    }

    return NextResponse.json({ ok: true, journey: data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
