import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/http";
import { getServerSupabase } from "@/lib/supabase-server";

const THUMB_TTL_SECONDS = 3600;
const SUMMARY_MAX_CHARS = 280;

type SiteRow = {
  id: string;
  slug: string;
  name_en: string;
  category: string;
  state: string | null;
  district: string | null;
  summary_en: string | null;
  lat: number;
  lng: number;
};

type AssetRow = {
  site_id: string | null;
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
};

export async function GET() {
  try {
    const db = getServerSupabase();

    // Service role bypasses RLS, so the published filter is explicit.
    const { data: siteData, error: siteErr } = await db
      .from("sites_geo")
      .select(
        "id, slug, name_en, category, state, district, summary_en, lat, lng",
      )
      .eq("status", "published")
      .not("lat", "is", null)
      .not("lng", "is", null)
      .limit(1000);
    if (siteErr) throw new Error(`Could not load sites: ${siteErr.message}`);
    const sites = (siteData ?? []) as SiteRow[];

    // First photo per site => signed thumbnail URL (the bucket is private)
    const urlByKey = new Map<string, string>();
    const firstPhoto = new Map<string, { bucket: string; path: string }>();

    if (sites.length > 0) {
      const { data: assetData, error: assetErr } = await db
        .from("assets")
        .select("site_id, storage_bucket, storage_path, mime_type")
        .in(
          "site_id",
          sites.map((s) => s.id),
        )
        .eq("kind", "photo")
        .order("created_at", { ascending: true });
      if (assetErr)
        throw new Error(`Could not load assets: ${assetErr.message}`);

      for (const a of (assetData ?? []) as AssetRow[]) {
        if (!a.site_id || firstPhoto.has(a.site_id)) continue;
        if (!a.mime_type?.startsWith("image/")) continue;
        firstPhoto.set(a.site_id, {
          bucket: a.storage_bucket,
          path: a.storage_path,
        });
      }

      const pathsByBucket = new Map<string, string[]>();
      for (const { bucket, path } of firstPhoto.values()) {
        pathsByBucket.set(bucket, [...(pathsByBucket.get(bucket) ?? []), path]);
      }
      for (const [bucket, paths] of pathsByBucket) {
        const { data: signed, error: signErr } = await db.storage
          .from(bucket)
          .createSignedUrls(paths, THUMB_TTL_SECONDS);
        if (signErr) {
          console.error("[api/sites] signing failed:", signErr.message);
          continue; // pins still render, just without photos
        }
        for (const s of signed ?? []) {
          if (s.signedUrl && s.path)
            urlByKey.set(`${bucket}/${s.path}`, s.signedUrl);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      sites: sites.map((s) => {
        const photo = firstPhoto.get(s.id);
        const summary = s.summary_en ?? "";
        return {
          id: s.id,
          slug: s.slug,
          name_en: s.name_en,
          category: s.category,
          state: s.state,
          district: s.district,
          summary_en:
            summary.length > SUMMARY_MAX_CHARS
              ? `${summary.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`
              : summary,
          lat: s.lat,
          lng: s.lng,
          thumbnail_url: photo
            ? (urlByKey.get(`${photo.bucket}/${photo.path}`) ?? null)
            : null,
        };
      }),
    });
  } catch (err) {
    console.error("[api/sites]", err);
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
