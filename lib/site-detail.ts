import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServerSupabase } from "@/lib/supabase-server";

const SIGNED_URL_TTL_SECONDS = 3600;
const RELATED_COUNT = 6;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type SiteInfo = {
  id: string;
  slug: string;
  name_en: string;
  name_local: string | null;
  category: string;
  state: string | null;
  district: string | null;
  region: string | null;
  address_text: string | null;
  period: string | null;
  crafts: string[];
  tags: string[];
  summary_en: string | null;
  folklore_notes: string | null;
  origin: string;
  location_source: string | null;
  location_confidence: number | null;
  needs_manual_location: boolean;
  uncertain_fields: string[];
  field_confidence: Record<string, number> | null;
  extraction_confidence: number | null;
  created_at: string;
  lat: number | null;
  lng: number | null;
};

export type GalleryImage = { id: string; url: string; caption: string | null };

export type PanoramaHotspot = {
  id: string;
  pitch: number;
  yaw: number;
  title: string;
  text: string;
  category?: "architecture" | "folklore" | "inscription" | "history" | "general";
};

export type PanoramaItem = {
  id: string;
  url: string;
  caption: string | null;
  hotspots: PanoramaHotspot[];
};

export type SourceDoc = {
  id: string;
  kind: "photo" | "scan" | "pano";
  fileUrl: string | null;
  isImage: boolean;
  isPdf: boolean;
  language: string | null;
  ocrText: string | null;
  textEn: string | null;
  ocrConfidence: number | null;
};

export type RelatedSite = {
  id: string;
  slug: string;
  name: string;
  type: string;
  era: string | null;
  state: string | null;
  district: string | null;
  similarity: number;
  basis: "embedding" | "metadata";
  thumbnail: string | null;
};

export type SiteDetail = {
  site: SiteInfo;
  photos: GalleryImage[];
  panos: PanoramaItem[];
  documents: SourceDoc[];
  related: RelatedSite[];
};

type AssetRow = {
  id: string;
  site_id: string | null;
  kind: "photo" | "scan" | "pano";
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
  caption: string | null;
  notes?: string | null;
  extracted?: Record<string, unknown> | null;
  language_detected: string | null;
  ocr_text: string | null;
  text_en: string | null;
  ocr_confidence: number | null;
};

type RelatedRow = {
  site_id: string;
  slug: string;
  name: string;
  type: string;
  era: string | null;
  state: string | null;
  district: string | null;
  similarity: number;
  basis: "embedding" | "metadata";
};

/** Bucket is private: map "bucket/path" -> short-lived signed URL. */
async function signAll(
  db: SupabaseClient,
  assets: Pick<AssetRow, "storage_bucket" | "storage_path">[],
): Promise<Map<string, string>> {
  const byBucket = new Map<string, string[]>();
  for (const a of assets)
    byBucket.set(a.storage_bucket, [
      ...(byBucket.get(a.storage_bucket) ?? []),
      a.storage_path,
    ]);

  const out = new Map<string, string>();
  for (const [bucket, paths] of byBucket) {
    const { data, error } = await db.storage
      .from(bucket)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (error) {
      console.error("[site-detail] signing failed:", error.message);
      continue; // the page still renders, just without those images
    }
    for (const s of data ?? [])
      if (s.signedUrl && s.path) out.set(`${bucket}/${s.path}`, s.signedUrl);
  }
  return out;
}

/** `idOrSlug` is a site uuid or slug. Returns null for unknown or unpublished sites. */
export async function getSiteDetail(
  idOrSlug: string,
): Promise<SiteDetail | null> {
  const isUuid = UUID_RE.test(idOrSlug);
  if (!isUuid && !SLUG_RE.test(idOrSlug)) return null;

  const db = getServerSupabase();

  // The service role bypasses RLS, so "published only" is enforced here.
  const { data: row, error } = await db
    .from("sites")
    .select(
      "id, slug, name_en, name_local, category, state, district, region, address_text, period, crafts, tags, summary_en, folklore_notes, origin, location_source, location_confidence, needs_manual_location, uncertain_fields, field_confidence, extraction_confidence, created_at",
    )
    .eq(isUuid ? "id" : "slug", idOrSlug)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw new Error(`Could not load site: ${error.message}`);
  if (!row) return null;

  const [geoRes, assetRes, relatedRes] = await Promise.all([
    db.from("sites_geo").select("lat, lng").eq("id", row.id).maybeSingle(),
    db
      .from("assets")
      .select(
        "id, site_id, kind, storage_bucket, storage_path, mime_type, caption, notes, extracted, language_detected, ocr_text, text_en, ocr_confidence",
      )
      .eq("site_id", row.id)
      .order("created_at", { ascending: true }),
    db.rpc("related_sites", {
      p_site_id: row.id,
      match_count: RELATED_COUNT,
    }),
  ]);
  if (assetRes.error)
    throw new Error(`Could not load assets: ${assetRes.error.message}`);
  // A failure in related_sites (e.g. migration 008 not applied yet) shouldn't take the page down.
  if (relatedRes.error)
    console.error("[site-detail] related_sites:", relatedRes.error.message);

  const assets = (assetRes.data ?? []) as AssetRow[];
  const related = (relatedRes.data ?? []) as RelatedRow[];

  // One thumbnail (first photo) per related site.
  let relatedThumbs: AssetRow[] = [];
  if (related.length > 0) {
    const { data: tData, error: tErr } = await db
      .from("assets")
      .select("id, site_id, kind, storage_bucket, storage_path, mime_type")
      .in(
        "site_id",
        related.map((r) => r.site_id),
      )
      .eq("kind", "photo")
      .order("created_at", { ascending: true });
    if (tErr) console.error("[site-detail] related thumbs:", tErr.message);
    const seen = new Set<string>();
    relatedThumbs = ((tData ?? []) as AssetRow[]).filter((a) => {
      if (!a.site_id || seen.has(a.site_id)) return false;
      if (!a.mime_type?.startsWith("image/")) return false;
      seen.add(a.site_id);
      return true;
    });
  }

  const urls = await signAll(db, [...assets, ...relatedThumbs]);
  const urlOf = (a: Pick<AssetRow, "storage_bucket" | "storage_path">) =>
    urls.get(`${a.storage_bucket}/${a.storage_path}`) ?? null;

  const photos: GalleryImage[] = [];
  const panos: PanoramaItem[] = [];
  const documents: SourceDoc[] = [];
  for (const a of assets) {
    const isImage = a.mime_type?.startsWith("image/") ?? false;
    const url = urlOf(a);
    if (a.kind === "photo" && isImage && url) {
      photos.push({ id: a.id, url, caption: a.caption });
    }
    if (a.kind === "pano" && isImage && url) {
      // Hotspots linking directly to cultural and architectural notes
      const customHotspots: PanoramaHotspot[] = Array.isArray(a.extracted?.hotspots)
        ? (a.extracted.hotspots as PanoramaHotspot[])
        : [];

      const derivedHotspots: PanoramaHotspot[] = [];
      if (customHotspots.length === 0) {
        if (row.summary_en) {
          derivedHotspots.push({
            id: `spot-arch-${a.id}`,
            pitch: 0,
            yaw: -15,
            title: "Architectural Form",
            text: row.summary_en.slice(0, 280),
            category: "architecture",
          });
        }
        if (row.folklore_notes) {
          derivedHotspots.push({
            id: `spot-folk-${a.id}`,
            pitch: 6,
            yaw: 70,
            title: "Folklore & Sacred Memory",
            text: row.folklore_notes,
            category: "folklore",
          });
        }
        if (row.period || (row.crafts && row.crafts.length > 0)) {
          derivedHotspots.push({
            id: `spot-hist-${a.id}`,
            pitch: -10,
            yaw: 160,
            title: "Period & Artisanal Context",
            text: `Era: ${row.period || "Heritage period"}. Known crafts: ${(row.crafts || []).join(", ") || "Indigenous masonry"}.`,
            category: "history",
          });
        }
        if (a.notes) {
          derivedHotspots.push({
            id: `spot-field-${a.id}`,
            pitch: 10,
            yaw: -110,
            title: "Archivist Field Notes",
            text: a.notes,
            category: "general",
          });
        }
      }

      panos.push({
        id: a.id,
        url,
        caption: a.caption,
        hotspots: customHotspots.length > 0 ? customHotspots : derivedHotspots,
      });
    }
    const hasText = !!(a.ocr_text?.trim() || a.text_en?.trim());
    if (a.kind === "scan" || hasText) {
      documents.push({
        id: a.id,
        kind: a.kind,
        fileUrl: url,
        isImage,
        isPdf: a.mime_type === "application/pdf",
        language: a.language_detected,
        ocrText: a.ocr_text?.trim() || null,
        textEn: a.text_en?.trim() || null,
        ocrConfidence: a.ocr_confidence,
      });
    }
  }

  const thumbBySite = new Map(
    relatedThumbs.map((a) => [a.site_id as string, urlOf(a)]),
  );

  const geo = geoRes.data as { lat: number | null; lng: number | null } | null;
  return {
    site: {
      ...(row as Omit<SiteInfo, "lat" | "lng">),
      crafts: row.crafts ?? [],
      tags: row.tags ?? [],
      uncertain_fields: row.uncertain_fields ?? [],
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
    },
    photos,
    panos,
    documents,
    related: related.map((r) => ({
      id: r.site_id,
      slug: r.slug,
      name: r.name,
      type: r.type,
      era: r.era,
      state: r.state,
      district: r.district,
      similarity: r.similarity,
      basis: r.basis,
      thumbnail: thumbBySite.get(r.site_id) ?? null,
    })),
  };
}
