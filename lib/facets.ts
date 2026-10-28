// Client-safe helpers shared by the map page, the search API and the site page.
// No server-only imports here.

export const CATEGORIES = [
  "stepwell",
  "fort",
  "temple",
  "palace",
  "haveli",
  "monument",
  "craft",
  "textile",
  "manuscript",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<string, string> = {
  stepwell: "Stepwell",
  fort: "Fort",
  temple: "Temple",
  palace: "Palace",
  haveli: "Haveli",
  monument: "Monument",
  craft: "Craft",
  textile: "Textile",
  manuscript: "Manuscript",
  other: "Other",
};

export function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

/* ---------------- era ---------------- */

export const ERA_BUCKETS = [
  "ancient",
  "early-medieval",
  "late-medieval",
  "colonial-modern",
  "living",
] as const;
export type EraBucket = (typeof ERA_BUCKETS)[number];

export const ERA_LABEL: Record<EraBucket, string> = {
  ancient: "Ancient (to 5th c.)",
  "early-medieval": "Early medieval (6th–12th c.)",
  "late-medieval": "Late medieval (13th–17th c.)",
  "colonial-modern": "Colonial & modern (18th c. on)",
  living: "Living tradition",
};

export function isEraBucket(v: string): v is EraBucket {
  return (ERA_BUCKETS as readonly string[]).includes(v);
}

/** Mirror of public.era_bucket() in sql/008_search_v2.sql. Keep the two in sync. */
export function eraBucket(period: string | null | undefined): EraBucket | null {
  const p = (period ?? "").toLowerCase();
  if (p.trim() === "") return null;
  if (/\b(bce|bc|ancient|vedic|mauryan|indus)\b/.test(p)) return "ancient";

  let century: number | null = null;
  const ord = p.match(/(\d{1,2})(?:st|nd|rd|th)/);
  if (ord) {
    century = Number(ord[1]);
  } else {
    const yr = p.match(/\b(\d{3,4})\b/);
    if (yr) century = Math.floor((Number(yr[1]) - 1) / 100) + 1;
  }
  if (century !== null) {
    if (century <= 5) return "ancient";
    if (century <= 12) return "early-medieval";
    if (century <= 17) return "late-medieval";
    return "colonial-modern";
  }
  if (/(tradition|contemporary|living|present)/.test(p)) return "living";
  return null;
}

/* ---------------- search DTOs ---------------- */

export type SiteDto = {
  id: string;
  slug: string;
  name_en: string;
  category: string;
  state: string | null;
  district: string | null;
  summary_en: string;
  period: string | null;
  era_bucket: EraBucket | null;
  crafts: string[];
  lat: number;
  lng: number;
  thumbnail_url: string | null;
};

export type SearchResultDto = {
  site_id: string;
  slug: string;
  name: string;
  type: string;
  era: string | null;
  era_bucket: EraBucket | null;
  state: string | null;
  district: string | null;
  crafts: string[];
  lat: number | null;
  lng: number | null;
  snippet: string;
  distance_m: number | null;
  semantic_sim: number | null;
  score: number;
  matched_signals: string[];
};

export type SearchResponse = {
  ok: boolean;
  error?: string;
  query?: string;
  results?: SearchResultDto[];
  note?: string;
  usedFallback?: boolean;
  place?: {
    requested: string;
    resolved: string | null;
    notFound: boolean;
    radius_km: number | null;
  } | null;
};

export type Filters = {
  types: string[];
  eras: EraBucket[];
  crafts: string[]; // lower-cased
};

export const EMPTY_FILTERS: Filters = { types: [], eras: [], crafts: [] };

export function hasFilters(f: Filters): boolean {
  return f.types.length + f.eras.length + f.crafts.length > 0;
}

/** Same rule the SQL uses: AND across facets, OR within a facet. */
export function siteMatchesFilters(s: SiteDto, f: Filters): boolean {
  if (f.types.length > 0 && !f.types.includes(s.category)) return false;
  if (f.eras.length > 0 && (!s.era_bucket || !f.eras.includes(s.era_bucket)))
    return false;
  if (
    f.crafts.length > 0 &&
    !s.crafts.some((c) => f.crafts.includes(c.toLowerCase()))
  )
    return false;
  return true;
}

/* ---------------- "why this matched" ---------------- */

export type WhyChip = {
  kind: "keyword" | "semantic" | "geo";
  label: string;
  title: string;
};

export const HL_OPEN = "«";
export const HL_CLOSE = "»";

/** Splits a ts_headline snippet (matches wrapped in « ») into plain text parts. */
export function splitHighlights(
  snippet: string,
): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = new RegExp(`${HL_OPEN}([^${HL_CLOSE}]*)${HL_CLOSE}`, "g");
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: snippet.slice(last, at), hit: false });
    parts.push({ text: m[1], hit: true });
    last = at + m[0].length;
  }
  if (last < snippet.length)
    parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

export function matchedTerms(snippet: string, max = 3): string[] {
  const seen = new Set<string>();
  for (const p of splitHighlights(snippet)) {
    if (!p.hit) continue;
    const t = p.text.trim().toLowerCase();
    if (t) seen.add(t);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function formatKm(m: number): string {
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function whyMatched(
  r: SearchResultDto,
  place: SearchResponse["place"],
): WhyChip[] {
  const chips: WhyChip[] = [];
  if (r.matched_signals.includes("keyword")) {
    const terms = matchedTerms(r.snippet);
    chips.push({
      kind: "keyword",
      label:
        terms.length > 0
          ? `Mentions ${terms.map((t) => `“${t}”`).join(", ")}`
          : "Keyword match",
      title: "The record's text contains your search words",
    });
  }
  if (r.matched_signals.includes("semantic")) {
    chips.push({
      kind: "semantic",
      label:
        r.semantic_sim != null
          ? `Similar meaning · ${Math.round(r.semantic_sim * 100)}%`
          : "Similar meaning",
      title: "Matched by meaning (embedding similarity), not exact words",
    });
  }
  if (r.matched_signals.includes("geo") && r.distance_m != null) {
    const where = place?.requested ?? "the place you named";
    chips.push({
      kind: "geo",
      label: `${formatKm(r.distance_m)} from ${where}`,
      title: place?.resolved
        ? `Distance from ${place.resolved}`
        : "Distance from the place in your search",
    });
  }
  return chips;
}
