// app/api/search/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { CATEGORIES, ERA_BUCKETS, type SearchResultDto } from "@/lib/facets";
import { errorMessage } from "@/lib/http";
import { geocodeQuery } from "@/lib/geocoding";
import { callLLM } from "@/lib/llm";
import { getServerSupabase } from "@/lib/supabase-server";

// No route segment config: cacheComponents rejects `dynamic`, `revalidate`, etc.

const QuerySchema = z.object({
  q: z.string().trim().min(1, "Query cannot be empty").max(500),
  // UI filters: repeat the param to select several (?type=fort&type=temple).
  // AND across facets, OR within one. They override the LLM-parsed type/era.
  type: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).default([]),
  era: z.array(z.enum(ERA_BUCKETS)).max(ERA_BUCKETS.length).default([]),
  craft: z
    .array(z.string().trim().min(1).max(60).transform((s) => s.toLowerCase()))
    .max(10)
    .default([]),
});

const DEFAULT_RADIUS_KM = 50; // applied when a place is named but no radius was stated
const MAX_RADIUS_KM = 500;
const MATCH_COUNT = 20;

type ParsedQuery = {
  topic: string;
  place: string | null;
  radius_km: number | null;
  era: string | null;
  type: string | null;
};

/** Safe fallback for when the LLM chain is unavailable, or parse_query
 *  somehow still throws after its own repair-retry: treat the whole raw
 *  query as the topic, with no place/era/type/radius filters. */
function fallbackParse(rawQuery: string): ParsedQuery {
  return {
    topic: rawQuery,
    place: null,
    radius_km: null,
    era: null,
    type: null,
  };
}

async function parseSearchQuery(
  rawQuery: string,
): Promise<{
  parsed: ParsedQuery;
  usedFallback: boolean;
  parseError?: string;
}> {
  try {
    const r = await callLLM("parse_query", { query: rawQuery });
    return {
      // callLLM already Zod-validates this against ParseQueryOutputSchema
      // (with a repair-retry on bad JSON) before it ever reaches here.
      parsed: {
        topic: r.output.topic,
        place: r.output.place,
        radius_km: r.output.radius_km,
        era: r.output.era,
        type: r.output.type,
      },
      usedFallback: false,
    };
  } catch (e) {
    console.warn(
      "[search] parse_query failed, falling back to raw-text search:",
      errorMessage(e),
    );
    return {
      parsed: fallbackParse(rawQuery),
      usedFallback: true,
      parseError: errorMessage(e),
    };
  }
}

// Row shape returned by search_sites() (sql/008_search_v2.sql).
type SiteResultRow = SearchResultDto;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsedParams = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    type: url.searchParams.getAll("type"),
    era: url.searchParams.getAll("era"),
    craft: url.searchParams.getAll("craft"),
  });
  if (!parsedParams.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsedParams.error.issues.map((i) => i.message).join("; "),
      },
      { status: 400 },
    );
  }
  const rawQuery = parsedParams.data.q;
  const uiTypes = parsedParams.data.type;
  const uiEras = parsedParams.data.era;
  const uiCrafts = parsedParams.data.craft;

  try {
    const db = getServerSupabase();

    const { parsed, usedFallback, parseError } =
      await parseSearchQuery(rawQuery);
    const topic = parsed.topic.trim();
    const place = parsed.place?.trim() || null;

    // CASE: no topic. If there's also no place, there's nothing structured
    // to search on at all — fall back to the raw query as the topic so we
    // always have SOME signal, rather than silently returning nothing. If
    // there IS a place, an empty topic is meaningful ("show me everything
    // near X") — don't substitute the raw query, that would re-introduce
    // the place name as noise into the keyword/semantic search.
    const effectiveTopic = topic || (!place ? rawQuery : "");

    // Embed the topic (query-purpose embedding), unless there's no topic.
    // Best-effort: embedding failure shouldn't take down keyword/geo search.
    let queryEmbedding: string | null = null; // pgvector text literal: "[0.1,0.2,...]"
    if (effectiveTopic) {
      try {
        const er = await callLLM("embed", {
          texts: [effectiveTopic],
          purpose: "query",
        });
        queryEmbedding = JSON.stringify(er.output.vectors[0]);
      } catch (e) {
        console.warn(
          "[search] embedding failed, continuing without semantic ranking:",
          errorMessage(e),
        );
      }
    }

    // CASE: a place was named. Geocode it — also best-effort: a geocoding
    // failure or an unresolvable place shouldn't take down a search that
    // still has a usable topic.
    let center: string | null = null; // EWKT text: "SRID=4326;POINT(lng lat)"
    let radiusM: number | null = null;
    let placeResolved: string | null = null;
    let placeNotFound = false;
    if (place) {
      try {
        const g = await geocodeQuery(db, place);
        if (g.point) {
          center = `SRID=4326;POINT(${g.point.lng} ${g.point.lat})`;
          placeResolved = g.displayName;
          const km =
            parsed.radius_km && parsed.radius_km > 0
              ? Math.min(parsed.radius_km, MAX_RADIUS_KM)
              : DEFAULT_RADIUS_KM;
          radiusM = Math.round(km * 1000);
        } else {
          placeNotFound = true;
        }
      } catch (e) {
        console.warn(`[search] could not geocode "${place}":`, errorMessage(e));
        placeNotFound = true;
      }
    }

    // A facet the user picked in the UI wins over what the LLM guessed from the text.
    const filters: Record<string, string> = {};
    if (parsed.type && uiTypes.length === 0) filters.type = parsed.type;
    if (parsed.era && uiEras.length === 0) filters.era = parsed.era;

    // CASE: nothing at all to search on (empty topic, no place, no filters —
    // e.g. parsing failed AND the raw query was itself empty-ish after
    // trimming, which QuerySchema should already reject, but belt-and-braces).
    // Don't call search_sites with every arg null — it would correctly
    // return zero rows, but that reads as a confusing "no results" for what
    // is really an empty query.
    if (!effectiveTopic && !center && Object.keys(filters).length === 0) {
      return NextResponse.json({
        ok: true,
        query: rawQuery,
        parsed,
        usedFallback,
        results: [],
        note: "Nothing to search on — try naming a place, a topic, or both.",
      });
    }

    const { data, error } = await db.rpc("search_sites", {
      query_embedding: queryEmbedding,
      query_text: effectiveTopic || null,
      center,
      radius_m: radiusM,
      filters,
      match_count: MATCH_COUNT,
      filter_types: uiTypes.length > 0 ? uiTypes : null,
      filter_crafts: uiCrafts.length > 0 ? uiCrafts : null,
      filter_eras: uiEras.length > 0 ? uiEras : null,
    });
    if (error) throw new Error(`Search failed: ${error.message}`);

    const results = (data ?? []) as SiteResultRow[];

    return NextResponse.json({
      ok: true,
      query: rawQuery,
      parsed,
      usedFallback,
      parseError: usedFallback ? parseError : undefined,
      place: place
        ? {
            requested: place,
            resolved: placeResolved,
            notFound: placeNotFound,
            radius_km: radiusM ? radiusM / 1000 : null,
          }
        : null,
      results,
      // CASE: no results.
      ...(results.length === 0
        ? {
            note: "No matching heritage records found. Try a broader area, a different topic, or fewer filters.",
          }
        : {}),
    });
  } catch (err) {
    console.error("[api/search]", err);
    return NextResponse.json(
      { ok: false, error: errorMessage(err) },
      { status: 500 },
    );
  }
}
