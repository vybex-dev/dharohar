"use client";

import Link from "next/link";
import { useState } from "react";
import type { JourneyDto } from "@/app/api/journeys/route";
import {
  type Filters,
  type WhyChip,
  EMPTY_FILTERS,
  categoryLabel,
  hasFilters,
  splitHighlights,
} from "@/lib/facets";

export type ResultRow = {
  id: string;
  name: string;
  category: string;
  state: string | null;
  district: string | null;
  era: string | null;
  thumbnail: string | null;
  text: string; // search snippet (with « » highlights) or the site summary
  highlight: boolean; // whether `text` carries « » markers
  chips: WhyChip[];
  rank: number | null;
};

export type FacetOption = { value: string; label: string };

type Props = {
  query: string;
  onQueryChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onPickExample: (q: string) => void;

  sitesStatus: "loading" | "ready" | "error";
  siteCount: number;

  facets: { types: FacetOption[]; eras: FacetOption[]; crafts: FacetOption[] };
  filters: Filters;
  onFiltersChange: (f: Filters) => void;

  mode: "browse" | "search";
  searching: boolean;
  searchError: string | null;
  onRetry: () => void;
  notes: string[]; // short context lines: "near Patan (50 km)", fallbacks, ...
  emptyNote: string | null;

  rows: ResultRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;

  // Journeys layer
  journeys?: JourneyDto[];
  selectedJourneyId?: string | null;
  onSelectJourney?: (id: string | null) => void;
  viewMode?: "sites" | "journeys";
  onViewModeChange?: (mode: "sites" | "journeys") => void;
  onSelectSiteStop?: (siteId: string) => void;
};

const EXAMPLES = [
  "stepwells near Patan",
  "Solanki-era temples",
  "block printing in Rajasthan",
];

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800 ${
        active
          ? "bg-amber-800 text-white ring-amber-800 shadow-sm"
          : "bg-white text-stone-700 ring-stone-300 hover:bg-stone-50"
      }`}
    >
      {children}
    </button>
  );
}

function FacetRow({
  label,
  options,
  selected,
  onToggle,
  limit,
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (v: string) => void;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  if (options.length === 0) return null;
  const shown =
    limit && !all && options.length > limit
      ? options.filter((o, i) => i < limit || selected.includes(o.value))
      : options;
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-600">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((o) => (
          <Chip
            key={o.value}
            active={selected.includes(o.value)}
            onClick={() => onToggle(o.value)}
          >
            {o.label}
          </Chip>
        ))}
        {limit && options.length > limit && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="rounded-full px-2 py-1 text-xs font-semibold text-amber-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-800"
          >
            {all ? "Fewer" : `+${options.length - limit} more`}
          </button>
        )}
      </div>
    </div>
  );
}

const CHIP_STYLE: Record<WhyChip["kind"], string> = {
  keyword: "bg-amber-50 text-amber-950 ring-amber-300",
  semantic: "bg-indigo-50 text-indigo-950 ring-indigo-300",
  geo: "bg-emerald-50 text-emerald-950 ring-emerald-300",
};

function WhyChipView({ chip }: { chip: WhyChip }) {
  return (
    <span
      title={chip.title}
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${CHIP_STYLE[chip.kind]}`}
    >
      <span aria-hidden className="text-[10px] leading-none">
        {chip.kind === "keyword" ? "Aa" : chip.kind === "semantic" ? "≈" : "◎"}
      </span>
      <span className="sr-only">Why this matched: </span>
      <span className="truncate">{chip.label}</span>
    </span>
  );
}

function Snippet({ row }: { row: ResultRow }) {
  if (!row.highlight) return <>{row.text}</>;
  return (
    <>
      {splitHighlights(row.text).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded bg-amber-200/80 px-0.5 text-inherit font-medium">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function Row({
  row,
  selected,
  onSelect,
  onHover,
}: {
  row: ResultRow;
  selected: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const meta = [categoryLabel(row.category), row.district, row.state]
    .filter(Boolean)
    .join(" · ");

  const altDescription = row.text
    ? `${row.name}: ${row.text.slice(0, 90)}`
    : `${row.name} heritage site photo`;

  return (
    <li
      id={`site-row-${row.id}`}
      onMouseEnter={() => onHover(row.id)}
      onMouseLeave={() => onHover(null)}
      className={`border-b border-stone-200 last:border-b-0 ${
        selected ? "bg-amber-50/80" : "hover:bg-stone-50"
      }`}
    >
      <div className="flex gap-3 px-3 py-3">
        <button
          type="button"
          onClick={() => onSelect(row.id)}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800 rounded"
        >
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-stone-100 ring-1 ring-stone-200">
            {row.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host
              <img
                src={row.thumbnail}
                alt={altDescription}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-stone-500">
                No photo
              </div>
            )}
            {row.rank !== null && (
              <span className="absolute left-0 top-0 rounded-br-md bg-amber-800 px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
                {row.rank}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-stone-900">
              {row.name}
            </div>
            <div className="truncate text-xs text-stone-600">
              {meta}
              {row.era ? ` · ${row.era}` : ""}
            </div>
            {row.text && (
              <p className="mt-1 line-clamp-2 text-xs leading-snug text-stone-700">
                <Snippet row={row} />
              </p>
            )}
            {row.chips.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {row.chips.map((c) => (
                  <WhyChipView key={c.kind} chip={c} />
                ))}
              </div>
            )}
          </div>
        </button>
        <Link
          href={`/sites/${row.id}`}
          aria-label={`Open details for ${row.name}`}
          className="self-start rounded px-2 py-1 text-xs font-semibold text-amber-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-amber-800"
        >
          Details →
        </Link>
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <ul aria-hidden className="animate-pulse" role="status" aria-label="Loading sites">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex gap-3 border-b border-stone-200 px-3 py-3">
          <div className="h-16 w-16 shrink-0 rounded-md bg-stone-200" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-2/3 rounded bg-stone-200" />
            <div className="h-2.5 w-1/2 rounded bg-stone-200" />
            <div className="h-2.5 w-full rounded bg-stone-200" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function SearchPanel(p: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sheetState, setSheetState] = useState<"peek" | "half" | "full">("half");
  const viewMode = p.viewMode ?? "sites";
  const journeys = p.journeys ?? [];

  const activeCount =
    p.filters.types.length + p.filters.eras.length + p.filters.crafts.length;

  const heading =
    p.sitesStatus === "loading"
      ? "Loading sites…"
      : p.sitesStatus === "error"
        ? "Could not load sites"
        : p.mode === "search"
          ? p.searching
            ? "Searching…"
            : p.searchError
              ? "Search failed"
              : `${p.rows.length} ${p.rows.length === 1 ? "result" : "results"}`
          : `${p.rows.length} of ${p.siteCount} sites`;

  const selectedJourney = journeys.find((j) => j.id === p.selectedJourneyId);

  return (
    <aside
      aria-label="Heritage explorer and search panel"
      className={`absolute z-10 flex flex-col overflow-hidden bg-white/98 text-stone-900 shadow-2xl ring-1 ring-black/10 backdrop-blur-md max-md:inset-x-0 max-md:bottom-0 max-md:rounded-t-2xl md:bottom-3 md:left-3 md:top-3 md:w-[400px] md:rounded-xl transition-all duration-300 ${
        sheetState === "peek"
          ? "max-md:h-[110px]"
          : sheetState === "full"
            ? "max-md:h-[86vh]"
            : "max-md:h-[54vh]"
      }`}
    >
      {/* Mobile drag handle & expand bar */}
      <div
        className="flex cursor-pointer items-center justify-center py-1.5 md:hidden"
        onClick={() =>
          setSheetState((s) => (s === "peek" ? "half" : s === "half" ? "full" : "peek"))
        }
        aria-label="Toggle mobile drawer height"
      >
        <div className="h-1.5 w-12 rounded-full bg-stone-300 hover:bg-stone-400" />
      </div>

      {/* Header with Title and Mode Switcher */}
      <div className="px-3.5 pt-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-serif text-lg font-bold tracking-tight text-amber-900">
              Dharohar
            </span>
            <span className="text-[11px] font-medium text-stone-600">
              Heritage atlas
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Link
              href="/upload"
              className="rounded-lg bg-amber-800 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-amber-800"
            >
              + Add
            </Link>

            {/* Mobile Sheet Toggle Pill */}
            <button
              type="button"
              onClick={() =>
                setSheetState((s) => (s === "peek" ? "half" : "peek"))
              }
              aria-label={sheetState === "peek" ? "Show list" : "Hide list to view map"}
              className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-stone-700 shadow-sm md:hidden"
            >
              {sheetState === "peek" ? "📋 List" : "🗺️ Map"}
            </button>
          </div>
        </div>

        {/* View Mode Tabs: Sites vs Journeys */}
        <div className="mt-2.5 flex rounded-lg bg-stone-100 p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => p.onViewModeChange?.("sites")}
            className={`flex-1 rounded-md py-1 text-center transition ${
              viewMode === "sites"
                ? "bg-white font-semibold text-stone-900 shadow-sm"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            🏛️ Heritage Sites ({p.siteCount})
          </button>
          <button
            type="button"
            onClick={() => p.onViewModeChange?.("journeys")}
            className={`flex-1 rounded-md py-1 text-center transition ${
              viewMode === "journeys"
                ? "bg-white font-semibold text-stone-900 shadow-sm"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            🧭 Journeys ({journeys.length})
          </button>
        </div>
      </div>

      {viewMode === "sites" ? (
        <>
          {/* Search Input Form */}
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              p.onSubmit();
            }}
            className="px-3.5 pt-2.5"
          >
            <div className="relative">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="9" cy="9" r="5.5" />
                <path d="m13.5 13.5 3.5 3.5" />
              </svg>
              <input
                type="search"
                value={p.query}
                onChange={(e) => p.onQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && p.query) {
                    e.preventDefault();
                    p.onClear();
                  }
                }}
                maxLength={500}
                placeholder="Try “stepwells near Patan”"
                aria-label="Search heritage sites"
                className="w-full rounded-lg border border-stone-300 bg-white py-2 pl-8 pr-16 text-sm text-stone-900 placeholder:text-stone-500 focus:border-amber-800 focus:outline-2 focus:outline-amber-800/30 [&::-webkit-search-cancel-button]:hidden"
              />
              {p.query && (
                <button
                  type="button"
                  onClick={p.onClear}
                  aria-label="Clear search query"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-amber-800"
                >
                  Clear
                </button>
              )}
            </div>
            {p.searching && (
              <div
                aria-hidden="true"
                className="mt-1.5 h-1 overflow-hidden rounded bg-stone-200"
              >
                <div className="h-full w-1/3 animate-[dh-slide_1.1s_ease-in-out_infinite] bg-amber-800" />
              </div>
            )}
          </form>

          {/* Filters Accordion Toggle */}
          <div className="px-3.5 pt-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setFiltersOpen((v) => !v)}
                aria-expanded={filtersOpen}
                aria-controls="dh-filters"
                className="flex items-center gap-1.5 rounded text-xs font-semibold text-stone-700 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-amber-800"
              >
                <span aria-hidden="true">{filtersOpen ? "▾" : "▸"}</span>
                Filters
                {activeCount > 0 && (
                  <span className="rounded-full bg-amber-800 px-1.5 text-[10px] font-bold text-white">
                    {activeCount}
                  </span>
                )}
              </button>
              {hasFilters(p.filters) && (
                <button
                  type="button"
                  onClick={() => p.onFiltersChange(EMPTY_FILTERS)}
                  className="text-xs font-semibold text-amber-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-800"
                >
                  Reset filters
                </button>
              )}
            </div>

            {filtersOpen && (
              <div id="dh-filters" className="mt-2.5 space-y-2.5 pb-1">
                <FacetRow
                  label="Type"
                  options={p.facets.types}
                  selected={p.filters.types}
                  onToggle={(v) =>
                    p.onFiltersChange({
                      ...p.filters,
                      types: toggle(p.filters.types, v),
                    })
                  }
                />
                <FacetRow
                  label="Era"
                  options={p.facets.eras}
                  selected={p.filters.eras}
                  onToggle={(v) =>
                    p.onFiltersChange({
                      ...p.filters,
                      eras: toggle(p.filters.eras, v as Filters["eras"][number]),
                    })
                  }
                />
                <FacetRow
                  label="Craft"
                  options={p.facets.crafts}
                  selected={p.filters.crafts}
                  limit={8}
                  onToggle={(v) =>
                    p.onFiltersChange({
                      ...p.filters,
                      crafts: toggle(p.filters.crafts, v),
                    })
                  }
                />
              </div>
            )}
          </div>

          {/* Results List Container */}
          <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-stone-200">
            <div
              role="status"
              aria-live="polite"
              className="px-3.5 py-2 text-xs font-semibold text-stone-700"
            >
              {heading}
              {p.notes.map((n) => (
                <span key={n} className="block font-normal text-stone-600">
                  {n}
                </span>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {p.sitesStatus === "loading" || p.searching ? (
                <Skeleton />
              ) : p.sitesStatus === "error" ? (
                <div role="alert" className="px-4 py-8 text-center text-sm text-stone-700">
                  <div className="text-2xl">⚠️</div>
                  <p className="mt-2 font-semibold">Could not load heritage sites</p>
                  <p className="mt-1 text-xs text-stone-600">
                    Check your connection and reload the atlas.
                  </p>
                </div>
              ) : p.searchError ? (
                <div role="alert" className="px-4 py-6 text-sm">
                  <p className="font-semibold text-red-900">{p.searchError}</p>
                  <button
                    type="button"
                    onClick={p.onRetry}
                    className="mt-3 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-stone-900"
                  >
                    Try again
                  </button>
                </div>
              ) : p.rows.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-lg text-stone-600">
                    🔍
                  </div>
                  <p className="mt-3 font-semibold text-stone-900">
                    {p.mode === "search"
                      ? "No records matched your search"
                      : hasFilters(p.filters)
                        ? "No sites match the selected filters"
                        : "No heritage records published yet"}
                  </p>
                  <p className="mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed text-stone-600">
                    {p.emptyNote ??
                      (hasFilters(p.filters)
                        ? "Try clearing one or more active filters above."
                        : "Upload a photo or scanned manuscript to add the first record.")}
                  </p>
                  <div className="mt-4 flex flex-col items-center gap-2">
                    {hasFilters(p.filters) && (
                      <button
                        type="button"
                        onClick={() => p.onFiltersChange(EMPTY_FILTERS)}
                        className="rounded-lg bg-amber-800 px-3.5 py-1.5 text-xs font-semibold text-white shadow hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-amber-800"
                      >
                        Clear filters
                      </button>
                    )}
                    {p.mode === "search" && (
                      <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                        {EXAMPLES.map((ex) => (
                          <button
                            key={ex}
                            type="button"
                            onClick={() => p.onPickExample(ex)}
                            className="rounded-full bg-white px-2.5 py-1 text-xs text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-amber-800"
                          >
                            {ex}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <ul role="list">
                  {p.rows.map((r) => (
                    <Row
                      key={r.id}
                      row={r}
                      selected={r.id === p.selectedId}
                      onSelect={p.onSelect}
                      onHover={p.onHover}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
        ) : (
          /* Journeys Mode List */
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-stone-200 px-3.5 py-2.5 bg-stone-50">
              <span className="text-xs font-semibold text-stone-700">
                Curated Historical Routes ({journeys.length})
              </span>
              <Link
                href="/journeys/new"
                className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-stone-900"
              >
                + Draw Route
              </Link>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
              {journeys.length === 0 ? (
                <div className="py-8 text-center">
                  <div className="text-2xl">🧭</div>
                  <p className="mt-2 text-sm font-semibold text-stone-800">
                    No journeys created yet
                  </p>
                  <p className="mt-1 text-xs text-stone-600">
                    Trace an architectural or craft circuit on the map.
                  </p>
                  <Link
                    href="/journeys/new"
                    className="mt-3 inline-block rounded-lg bg-amber-800 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-900"
                  >
                    Draw first journey
                  </Link>
                </div>
              ) : (
                journeys.map((j) => {
                  const isSelected = j.id === p.selectedJourneyId;
                  return (
                    <div
                      key={j.id}
                      className={`rounded-xl border p-3.5 transition shadow-sm ${
                        isSelected
                          ? "border-amber-700 bg-amber-50/70 ring-1 ring-amber-700"
                          : "border-stone-200 bg-white hover:border-amber-400"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            p.onSelectJourney?.(isSelected ? null : j.id)
                          }
                          className="flex-1 text-left focus-visible:outline-2 focus-visible:outline-amber-800 rounded"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="h-3 w-3 shrink-0 rounded-full"
                              style={{ backgroundColor: j.color }}
                            />
                            <h3 className="text-sm font-bold text-stone-900">
                              {j.title}
                            </h3>
                          </div>
                          {j.era && (
                            <p className="mt-0.5 text-xs text-stone-600">
                              {j.era}
                            </p>
                          )}
                        </button>
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-bold text-stone-800">
                          {j.distanceKm} km
                        </span>
                      </div>

                      {j.description && (
                        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-stone-700">
                          {j.description}
                        </p>
                      )}

                      {/* Stops list along this journey */}
                      {j.stops.length > 0 && (
                        <div className="mt-3 border-t border-stone-200/80 pt-2.5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500">
                            Stops along this route ({j.stops.length})
                          </span>
                          <ol className="mt-1.5 space-y-1">
                            {j.stops.map((stop, sIdx) => (
                              <li
                                key={stop.id}
                                className="flex items-center justify-between text-xs"
                              >
                                <button
                                  type="button"
                                  onClick={() => p.onSelectSiteStop?.(stop.id)}
                                  className="flex items-center gap-1.5 font-medium text-stone-800 hover:text-amber-800 hover:underline"
                                >
                                  <span
                                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                                    style={{ backgroundColor: j.color }}
                                  >
                                    {sIdx + 1}
                                  </span>
                                  <span className="truncate">{stop.name}</span>
                                </button>
                                <Link
                                  href={`/sites/${stop.id}`}
                                  className="text-[11px] font-semibold text-amber-800 hover:underline"
                                >
                                  View →
                                </Link>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
    </aside>
  );
}
