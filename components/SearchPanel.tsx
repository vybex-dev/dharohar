"use client";

import Link from "next/link";
import { useState } from "react";
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
      className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 ${
        active
          ? "bg-amber-700 text-white ring-amber-700"
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
  // Keep selected options visible even when the list is collapsed.
  const shown =
    limit && !all && options.length > limit
      ? options.filter(
          (o, i) => i < limit || selected.includes(o.value),
        )
      : options;
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
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
            className="rounded-full px-2 py-1 text-xs text-amber-800 underline underline-offset-2"
          >
            {all ? "Fewer" : `+${options.length - limit} more`}
          </button>
        )}
      </div>
    </div>
  );
}

const CHIP_STYLE: Record<WhyChip["kind"], string> = {
  keyword: "bg-amber-50 text-amber-900 ring-amber-200",
  semantic: "bg-indigo-50 text-indigo-900 ring-indigo-200",
  geo: "bg-emerald-50 text-emerald-900 ring-emerald-200",
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
          <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-inherit">
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
  return (
    <li
      id={`site-row-${row.id}`}
      onMouseEnter={() => onHover(row.id)}
      onMouseLeave={() => onHover(null)}
      className={`border-b border-stone-200 last:border-b-0 ${
        selected ? "bg-amber-50" : "hover:bg-stone-50"
      }`}
    >
      <div className="flex gap-3 px-3 py-3">
        <button
          type="button"
          onClick={() => onSelect(row.id)}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
        >
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-stone-100">
            {row.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host
              <img
                src={row.thumbnail}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-stone-400">
                No photo
              </div>
            )}
            {row.rank !== null && (
              <span className="absolute left-0 top-0 rounded-br-md bg-amber-700 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {row.rank}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-stone-900">
              {row.name}
            </div>
            <div className="truncate text-xs text-stone-500">
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
          className="self-start rounded px-1.5 py-1 text-xs font-medium text-amber-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-amber-700"
        >
          Details →
        </Link>
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <ul aria-hidden className="animate-pulse">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex gap-3 border-b border-stone-200 px-3 py-3">
          <div className="h-16 w-16 rounded-md bg-stone-200" />
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
  const [listOpen, setListOpen] = useState(true); // mobile only; always open on md+
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

  return (
    <aside
      aria-label="Search heritage sites"
      className={`absolute z-10 flex flex-col overflow-hidden bg-white/97 text-stone-900 shadow-xl ring-1 ring-black/5 max-md:inset-x-0 max-md:bottom-0 max-md:rounded-t-2xl md:bottom-3 md:left-3 md:top-3 md:w-[380px] md:rounded-xl ${
        listOpen ? "max-md:h-[52vh]" : "max-md:h-auto"
      }`}
    >
      <div className="flex items-center gap-3 px-3 pt-3">
        <span className="text-lg font-bold tracking-tight">Dharohar</span>
        <span className="text-xs text-stone-500">Heritage atlas</span>
        <Link
          href="/upload"
          className="ml-auto rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
        >
          + Add
        </Link>
      </div>

      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
        className="px-3 pt-3"
      >
        <div className="relative">
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
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
            className="w-full rounded-lg border border-stone-300 bg-white py-2 pl-8 pr-16 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-700 focus:outline-2 focus:outline-amber-700/30 [&::-webkit-search-cancel-button]:hidden"
          />
          {p.query && (
            <button
              type="button"
              onClick={p.onClear}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs text-stone-500 hover:bg-stone-100"
            >
              Clear
            </button>
          )}
        </div>
        {p.searching && (
          <div
            aria-hidden
            className="mt-1.5 h-0.5 overflow-hidden rounded bg-stone-200"
          >
            <div className="h-full w-1/3 animate-[dh-slide_1.1s_ease-in-out_infinite] bg-amber-700" />
          </div>
        )}
      </form>

      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-controls="dh-filters"
          className="flex items-center gap-1.5 rounded text-xs font-medium text-stone-700 hover:text-stone-900"
        >
          <span aria-hidden>{filtersOpen ? "▾" : "▸"}</span>
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-amber-700 px-1.5 text-[10px] font-bold text-white">
              {activeCount}
            </span>
          )}
        </button>
        {hasFilters(p.filters) && (
          <button
            type="button"
            onClick={() => p.onFiltersChange(EMPTY_FILTERS)}
            className="ml-3 text-xs text-amber-800 underline underline-offset-2"
          >
            Reset filters
          </button>
        )}
        <button
          type="button"
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
          className="float-right text-xs text-stone-500 md:hidden"
        >
          {listOpen ? "Hide list" : "Show list"}
        </button>
        {filtersOpen && (
          <div id="dh-filters" className="mt-2 space-y-2.5 pb-1">
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

      <div
        className={`mt-2 flex min-h-0 flex-1 flex-col border-t border-stone-200 ${
          listOpen ? "" : "max-md:hidden"
        }`}
      >
        <div
          role="status"
          aria-live="polite"
          className="px-3 py-2 text-xs font-medium text-stone-600"
        >
          {heading}
          {p.notes.map((n) => (
            <span key={n} className="block font-normal text-stone-500">
              {n}
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {p.sitesStatus === "loading" || p.searching ? (
            <Skeleton />
          ) : p.sitesStatus === "error" ? (
            <div className="px-3 py-6 text-sm text-stone-600">
              The site list could not be loaded. Check your connection and
              reload the page.
            </div>
          ) : p.searchError ? (
            <div role="alert" className="px-3 py-6 text-sm">
              <p className="text-red-800">{p.searchError}</p>
              <button
                type="button"
                onClick={p.onRetry}
                className="mt-3 rounded bg-stone-900 px-3 py-1.5 text-xs font-medium text-white"
              >
                Try again
              </button>
            </div>
          ) : p.rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-stone-600">
              <p className="font-medium text-stone-800">
                {p.mode === "search"
                  ? "Nothing matched"
                  : hasFilters(p.filters)
                    ? "No sites fit these filters"
                    : "No sites published yet"}
              </p>
              <p className="mx-auto mt-1 max-w-[28ch] text-xs text-stone-500">
                {p.emptyNote ??
                  (hasFilters(p.filters)
                    ? "Try removing a filter."
                    : "Upload a photo or scan to add the first one.")}
              </p>
              <div className="mt-4 flex flex-col items-center gap-2">
                {hasFilters(p.filters) && (
                  <button
                    type="button"
                    onClick={() => p.onFiltersChange(EMPTY_FILTERS)}
                    className="rounded bg-stone-900 px-3 py-1.5 text-xs font-medium text-white"
                  >
                    Reset filters
                  </button>
                )}
                {p.mode === "search" && (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => p.onPickExample(ex)}
                        className="rounded-full bg-white px-2.5 py-1 text-xs text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
                {p.mode === "browse" && !hasFilters(p.filters) && (
                  <Link
                    href="/upload"
                    className="rounded bg-amber-700 px-3 py-1.5 text-xs font-medium text-white"
                  >
                    + Add a site
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <ul>
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
    </aside>
  );
}
