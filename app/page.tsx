"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker, Popup } from "maplibre-gl";
import type { JourneyDto } from "@/app/api/journeys/route";
import SearchPanel, {
  type FacetOption,
  type ResultRow,
} from "@/components/SearchPanel";
import {
  CATEGORIES,
  EMPTY_FILTERS,
  ERA_BUCKETS,
  ERA_LABEL,
  categoryLabel,
  siteMatchesFilters,
  whyMatched,
  type Filters,
  type SearchResponse,
  type SiteDto,
} from "@/lib/facets";
import { buildStyle, workerUrl } from "@/lib/map-style";

type MapLibre = typeof import("maplibre-gl");
type SitesResponse = { ok: boolean; sites?: SiteDto[]; error?: string };
type SearchState = {
  key: string;
  data?: SearchResponse;
  error?: string;
} | null;

const SEARCH_DEBOUNCE_MS = 600;
const MIN_QUERY_CHARS = 2;

// Built with DOM nodes + textContent (never HTML strings) so uploaded titles can't inject markup.
function buildPopupContent(
  site: SiteDto,
  onOpen: (id: string) => void,
): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText =
    "width:230px;color:#111;font-family:system-ui,sans-serif";

  if (site.thumbnail_url) {
    const img = document.createElement("img");
    img.src = site.thumbnail_url;
    img.alt = site.summary_en
      ? `${site.name_en} - ${site.summary_en.slice(0, 100)}`
      : `${site.name_en} photo`;
    img.loading = "lazy";
    img.style.cssText =
      "width:100%;height:120px;object-fit:cover;border-radius:6px;margin-bottom:6px";
    root.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.textContent = "No photo yet";
    ph.style.cssText =
      "height:48px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;color:#6b7280;border-radius:6px;margin-bottom:6px;font-size:12px";
    root.appendChild(ph);
  }

  const name = document.createElement("div");
  name.textContent = site.name_en;
  name.style.cssText = "font-weight:600;font-size:15px";
  root.appendChild(name);

  const meta = [site.category, site.district, site.state]
    .filter(Boolean)
    .join(" · ");
  if (meta) {
    const m = document.createElement("div");
    m.textContent = meta;
    m.style.cssText = "color:#6b7280;font-size:12px;margin:2px 0 4px";
    root.appendChild(m);
  }

  if (site.summary_en) {
    const s = document.createElement("div");
    s.textContent = site.summary_en;
    s.style.cssText =
      "font-size:13px;line-height:1.35;max-height:110px;overflow:auto";
    root.appendChild(s);
  }

  const link = document.createElement("a");
  link.href = `/sites/${site.id}`;
  link.textContent = "Open full record →";
  link.style.cssText =
    "display:inline-block;margin-top:8px;font-size:13px;font-weight:600;color:#92400e";
  link.addEventListener("click", (e) => {
    // Plain clicks use client-side navigation; modified clicks keep the browser default.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(site.id);
  });
  root.appendChild(link);
  return root;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A pin whose look is driven by data-state ("hover" | "active") in globals.css.
// Wrapped in a div because maplibre positions the outer element with its own transform.
function buildPin(
  site: SiteDto,
  handlers: {
    select: (id: string) => void;
    hover: (id: string | null) => void;
  },
): { el: HTMLElement; setRank: (rank: number | null) => void } {
  const el = document.createElement("div");
  el.className = "dh-marker";
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.setAttribute("aria-label", site.name_en);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 28 36");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "36");
  svg.setAttribute("aria-hidden", "true");
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("class", "dh-pin-body");
  body.setAttribute(
    "d",
    "M14 0C6.3 0 0 6.1 0 13.6 0 23.8 14 36 14 36s14-12.2 14-22.4C28 6.1 21.7 0 14 0z",
  );
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", "14");
  dot.setAttribute("cy", "13.5");
  dot.setAttribute("r", "5");
  dot.setAttribute("fill", "#fff");
  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("x", "14");
  label.setAttribute("y", "17.2");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("font-size", "11");
  label.setAttribute("font-weight", "700");
  label.setAttribute("font-family", "system-ui,sans-serif");
  label.setAttribute("fill", "#7c2d12");
  svg.append(body, dot, label);
  el.appendChild(svg);

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    handlers.select(site.id);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlers.select(site.id);
    }
  });
  el.addEventListener("mouseenter", () => handlers.hover(site.id));
  el.addEventListener("mouseleave", () => handlers.hover(null));

  return {
    el,
    setRank(rank) {
      if (rank === null) {
        dot.setAttribute("r", "5");
        label.textContent = "";
      } else {
        dot.setAttribute("r", rank > 9 ? "8.5" : "7");
        label.setAttribute("font-size", rank > 9 ? "9.5" : "11");
        label.textContent = String(rank);
      }
    },
  };
}

type PinHandle = { marker: Marker; setRank: (rank: number | null) => void };

export default function HomePage() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibre | null>(null);
  const pinsRef = useRef(new globalThis.Map<string, PinHandle>());
  const popupRef = useRef<Popup | null>(null);
  const selectFromRef = useRef<"list" | "map" | null>(null);
  const skipNextFitRef = useRef(false);

  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteDto[]>([]);
  const [journeys, setJourneys] = useState<JourneyDto[]>([]);
  const [selectedJourneyId, setSelectedJourneyId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"sites" | "journeys">("sites");

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [retryN, setRetryN] = useState(0);
  const [result, setResult] = useState<SearchState>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  /* ---------------- map + pins ---------------- */

  const selectSite = useCallback((id: string, from: "list" | "map") => {
    selectFromRef.current = from;
    setSelectedId(id);
  }, []);

  useEffect(() => {
    let disposed = false;
    const pins = pinsRef.current;

    async function init() {
      try {
        // Named exports only: the default export is undefined under Turbopack.
        const lib = await import("maplibre-gl");
        if (disposed || !containerRef.current) return;
        libRef.current = lib;
        lib.setWorkerUrl(workerUrl());

        const map = new lib.Map({
          container: containerRef.current,
          style: buildStyle(),
          center: [75.5, 25.0], // Gujarat / Rajasthan
          zoom: 5,
        });
        mapRef.current = map;
        map.addControl(new lib.NavigationControl(), "top-right");

        // Fetch sites and journeys in parallel
        const [res, jRes] = await Promise.all([
          fetch("/api/sites"),
          fetch("/api/journeys").catch(() => null),
        ]);

        const data = (await res.json()) as SitesResponse;
        if (disposed) return;
        if (!res.ok || !data.ok || !data.sites) {
          throw new Error(
            data.error ?? `Could not load sites (HTTP ${res.status})`,
          );
        }

        let loadedJourneys: JourneyDto[] = [];
        if (jRes && jRes.ok) {
          try {
            const jData = await jRes.json();
            if (jData.ok && Array.isArray(jData.journeys)) {
              loadedJourneys = jData.journeys;
              setJourneys(loadedJourneys);
            }
          } catch {
            // non-fatal
          }
        }

        // Add site pins
        for (const site of data.sites) {
          const pin = buildPin(site, {
            select: (id) => selectSite(id, "map"),
            hover: setHoverId,
          });
          const marker = new lib.Marker({ element: pin.el, anchor: "bottom" })
            .setLngLat([site.lng, site.lat])
            .addTo(map);
          pins.set(site.id, { marker, setRank: pin.setRank });
        }
        setSites(data.sites);

        // Add journeys route layers once map style is loaded
        const addJourneyLayers = () => {
          if (disposed || !map.isStyleLoaded()) return;

          const features: GeoJSON.Feature[] = loadedJourneys.map((j) => ({
            type: "Feature",
            properties: {
              id: j.id,
              slug: j.slug,
              title: j.title,
              color: j.color || "#b45309",
            },
            geometry: j.routeGeojson,
          }));

          if (!map.getSource("journeys-routes")) {
            map.addSource("journeys-routes", {
              type: "geojson",
              data: {
                type: "FeatureCollection",
                features,
              },
            });

            // Translucent glowing casing
            map.addLayer({
              id: "journeys-casing",
              type: "line",
              source: "journeys-routes",
              paint: {
                "line-color": ["get", "color"],
                "line-width": 8,
                "line-opacity": 0.35,
              },
            });

            // Solid route line
            map.addLayer({
              id: "journeys-line",
              type: "line",
              source: "journeys-routes",
              paint: {
                "line-color": ["get", "color"],
                "line-width": 4,
                "line-opacity": 0.95,
              },
            });

            map.on("click", "journeys-line", (e) => {
              const f = e.features?.[0];
              if (f?.properties?.id) {
                setSelectedJourneyId(f.properties.id);
                setViewMode("journeys");
              }
            });

            map.on("mouseenter", "journeys-line", () => {
              map.getCanvas().style.cursor = "pointer";
            });
            map.on("mouseleave", "journeys-line", () => {
              map.getCanvas().style.cursor = "";
            });
          }
        };

        if (map.isStyleLoaded()) {
          addJourneyLayers();
        } else {
          map.once("load", addJourneyLayers);
        }

        // Deep links: /?site=<id>, /?q=<text>, /?journey=<slug>
        const sp = new URLSearchParams(window.location.search);
        const q = sp.get("q")?.slice(0, 500) ?? "";
        if (q) {
          setQuery(q);
          setSubmitted(q.trim());
        }

        const wantedJourney = sp.get("journey");
        if (wantedJourney && loadedJourneys.length > 0) {
          const targetJ = loadedJourneys.find(
            (j) => j.slug === wantedJourney || j.id === wantedJourney,
          );
          if (targetJ) {
            setViewMode("journeys");
            setSelectedJourneyId(targetJ.id);
          }
        }

        const wanted = sp.get("site");
        const target = wanted
          ? data.sites.find((s) => s.id === wanted)
          : undefined;
        if (target) {
          skipNextFitRef.current = true;
          map.jumpTo({ center: [target.lng, target.lat], zoom: 13 });
          selectFromRef.current = null;
          setSelectedId(target.id);
        }
        setMapReady(true);
        setStatus("ready");
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : "Map failed to load");
        setStatus("error");
      }
    }

    void init();
    return () => {
      disposed = true;
      popupRef.current?.remove();
      popupRef.current = null;
      pins.forEach((p) => p.marker.remove());
      pins.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [selectSite]);

  /* ---------------- search ---------------- */

  const filtersKey = JSON.stringify(filters);
  const searchKey = submitted
    ? JSON.stringify([submitted, filtersKey, retryN])
    : "";
  const pending = searchKey !== "" && result?.key !== searchKey;

  // Debounce typing into a submitted query. Clearing is handled in the change handler.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_CHARS || q === submitted) return;
    const t = setTimeout(() => setSubmitted(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, submitted]);

  useEffect(() => {
    if (!searchKey) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({ q: submitted });
    const f = JSON.parse(filtersKey) as Filters;
    f.types.forEach((v) => params.append("type", v));
    f.eras.forEach((v) => params.append("era", v));
    f.crafts.forEach((v) => params.append("craft", v));

    (async () => {
      try {
        const res = await fetch(`/api/search?${params}`, {
          signal: ctrl.signal,
        });
        const data = (await res.json()) as SearchResponse;
        if (!res.ok || !data.ok) {
          throw new Error(data.error ?? `Search failed (HTTP ${res.status})`);
        }
        setResult({ key: searchKey, data });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setResult({
          key: searchKey,
          error: e instanceof Error ? e.message : "Search failed",
        });
      }
    })();
    return () => ctrl.abort();
  }, [searchKey, submitted, filtersKey]);

  // Keep ?q= in the address bar so a search can be shared (and survives reload).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (submitted) url.searchParams.set("q", submitted);
    else url.searchParams.delete("q");
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, [submitted]);

  /* ---------------- derived view model ---------------- */

  const siteById = useMemo(
    () => new globalThis.Map(sites.map((s) => [s.id, s])),
    [sites],
  );

  const filteredSites = useMemo(
    () =>
      sites
        .filter((s) => siteMatchesFilters(s, filters))
        .sort((a, b) => a.name_en.localeCompare(b.name_en)),
    [sites, filters],
  );

  const searchActive = submitted !== "";
  // The latest *completed* search keeps the pins steady while the next one is in flight.
  const lastData = searchActive ? result?.data : undefined;
  const response = !pending && result?.key === searchKey ? result : null;
  const searchError = response?.error ?? null;

  const rows: ResultRow[] = useMemo(() => {
    if (searchActive) {
      const d = response?.data;
      if (!d?.results) return [];
      return d.results.map((r, i) => {
        const site = siteById.get(r.site_id);
        return {
          id: r.site_id,
          name: r.name,
          category: r.type,
          state: r.state,
          district: r.district,
          era: r.era,
          thumbnail: site?.thumbnail_url ?? null,
          text: r.snippet,
          highlight: r.matched_signals.includes("keyword"),
          chips: whyMatched(r, d.place),
          rank: i + 1,
        };
      });
    }
    return filteredSites.map((s) => ({
      id: s.id,
      name: s.name_en,
      category: s.category,
      state: s.state,
      district: s.district,
      era: s.period,
      thumbnail: s.thumbnail_url,
      text: s.summary_en,
      highlight: false,
      chips: [],
      rank: null,
    }));
  }, [searchActive, response, siteById, filteredSites]);

  // Which pins to show, in rank order, and the rank each carries.
  const pinOrder = useMemo(() => {
    if (searchActive && lastData?.results) {
      return lastData.results
        .map((r) => r.site_id)
        .filter((id) => siteById.has(id));
    }
    return filteredSites.map((s) => s.id);
  }, [searchActive, lastData, siteById, filteredSites]);
  const pinKey = pinOrder.join(",");
  const showRanks = searchActive && !!lastData?.results;

  const facets = useMemo(() => {
    const present = new Set(sites.map((s) => s.category));
    const types: FacetOption[] = CATEGORIES.filter((c) => present.has(c)).map(
      (c) => ({ value: c, label: categoryLabel(c) }),
    );
    // categories outside the known list (future-proofing) still get a chip
    for (const c of present)
      if (!(CATEGORIES as readonly string[]).includes(c))
        types.push({ value: c, label: categoryLabel(c) });

    const eraSet = new Set(sites.map((s) => s.era_bucket).filter(Boolean));
    const eras: FacetOption[] = ERA_BUCKETS.filter((e) => eraSet.has(e)).map(
      (e) => ({ value: e, label: ERA_LABEL[e] }),
    );

    const counts = new globalThis.Map<string, { label: string; n: number }>();
    for (const s of sites)
      for (const c of s.crafts) {
        const k = c.toLowerCase();
        const cur = counts.get(k);
        if (cur) cur.n += 1;
        else counts.set(k, { label: c, n: 1 });
      }
    const crafts: FacetOption[] = [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([value, v]) => ({
        value,
        label: v.label.charAt(0).toUpperCase() + v.label.slice(1),
      }));
    return { types, eras, crafts };
  }, [sites]);

  const notes: string[] = [];
  const d = response?.data;
  if (d?.place) {
    if (d.place.notFound)
      notes.push(
        `Couldn’t locate “${d.place.requested}” — searched by topic only.`,
      );
    else if (d.place.radius_km)
      notes.push(
        `Near ${d.place.requested} (within ${Math.round(d.place.radius_km)} km)`,
      );
  }
  if (d?.usedFallback)
    notes.push("Smart query parsing is unavailable; used plain text search.");

  /* ---------------- pin sync (visibility, ranks, highlight) ---------------- */

  useEffect(() => {
    if (!mapReady) return;
    const order = pinKey ? pinKey.split(",") : [];
    const rank = new globalThis.Map(order.map((id, i) => [id, i + 1]));
    for (const [id, pin] of pinsRef.current) {
      const r = rank.get(id);
      pin.marker.getElement().style.display = r === undefined ? "none" : "";
      pin.setRank(r !== undefined && showRanks ? r : null);
    }
  }, [mapReady, pinKey, showRanks]);

  useEffect(() => {
    for (const [id, pin] of pinsRef.current) {
      const el = pin.marker.getElement();
      const state =
        id === selectedId ? "active" : id === hoverId ? "hover" : "";
      if (state) el.dataset.state = state;
      else delete el.dataset.state;
      el.style.zIndex = state === "active" ? "3" : state ? "2" : "";
    }
  }, [mapReady, selectedId, hoverId]);

  // Frame whatever is currently pinned, leaving room for the panel.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!mapReady || !map || !lib || !pinKey) return;
    if (skipNextFitRef.current) {
      skipNextFitRef.current = false;
      return;
    }
    const bounds = new lib.LngLatBounds();
    for (const id of pinKey.split(",")) {
      const s = siteById.get(id);
      if (s) bounds.extend([s.lng, s.lat]);
    }
    if (bounds.isEmpty()) return;
    const wide = window.innerWidth >= 768;
    map.fitBounds(bounds, {
      padding: wide
        ? { top: 70, right: 70, bottom: 70, left: 420 }
        : { top: 70, right: 40, bottom: 220, left: 40 },
      maxZoom: 12,
      duration: 600,
    });
  }, [mapReady, pinKey, siteById]);

  // Fit bounds when a journey is selected
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!mapReady || !map || !lib || !selectedJourneyId) return;

    const j = journeys.find((x) => x.id === selectedJourneyId);
    if (!j?.routeGeojson?.coordinates?.length) return;

    const bounds = new lib.LngLatBounds();
    for (const [lng, lat] of j.routeGeojson.coordinates) {
      bounds.extend([lng, lat]);
    }
    if (bounds.isEmpty()) return;

    const wide = window.innerWidth >= 768;
    map.fitBounds(bounds, {
      padding: wide
        ? { top: 80, right: 80, bottom: 80, left: 440 }
        : { top: 70, right: 40, bottom: 240, left: 40 },
      maxZoom: 12,
      duration: 700,
    });
  }, [selectedJourneyId, journeys, mapReady]);

  // One popup, owned by the selection.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!mapReady || !map || !lib) return;

    const prev = popupRef.current;
    popupRef.current = null; // so prev's close handler knows it was replaced
    prev?.remove();

    const site = selectedId ? siteById.get(selectedId) : undefined;
    if (!site) return;

    const popup = new lib.Popup({
      offset: 38,
      maxWidth: "260px",
      closeOnClick: false,
    })
      .setLngLat([site.lng, site.lat])
      .setDOMContent(buildPopupContent(site, (id) => router.push(`/sites/${id}`)))
      .addTo(map);
    popup.on("close", () => {
      if (popupRef.current === popup) {
        popupRef.current = null;
        setSelectedId((cur) => (cur === site.id ? null : cur));
      }
    });
    popupRef.current = popup;

    const from = selectFromRef.current;
    selectFromRef.current = null;
    if (from === "list") {
      map.flyTo({
        center: [site.lng, site.lat],
        zoom: Math.max(map.getZoom(), 11),
        duration: 700,
        essential: false,
      });
    } else if (from === "map") {
      document
        .getElementById(`site-row-${site.id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [mapReady, selectedId, siteById, router]);

  /* ---------------- handlers ---------------- */

  const onQueryChange = (v: string) => {
    setQuery(v);
    if (v.trim() === "") setSubmitted("");
  };
  const clearSearch = () => {
    setQuery("");
    setSubmitted("");
  };
  const submitNow = () => {
    const q = query.trim();
    if (q.length >= MIN_QUERY_CHARS) {
      setSubmitted(q);
      setRetryN((n) => n + 1); // Enter on an unchanged query re-runs it
    }
  };
  const pickExample = (q: string) => {
    setQuery(q);
    setSubmitted(q);
  };

  return (
    <main className="fixed inset-0">
      {/* maplibre adds its own positioning class to this node, so it fills a wrapper instead of being fixed itself */}
      <div ref={containerRef} className="h-full w-full" />

      <SearchPanel
        query={query}
        onQueryChange={onQueryChange}
        onSubmit={submitNow}
        onClear={clearSearch}
        onPickExample={pickExample}
        sitesStatus={status}
        siteCount={sites.length}
        facets={facets}
        filters={filters}
        onFiltersChange={setFilters}
        mode={searchActive ? "search" : "browse"}
        searching={searchActive && pending}
        searchError={searchActive ? searchError : null}
        onRetry={() => setRetryN((n) => n + 1)}
        notes={notes}
        emptyNote={d?.note ?? null}
        rows={rows}
        selectedId={selectedId}
        onSelect={(id) => selectSite(id, "list")}
        onHover={setHoverId}
        journeys={journeys}
        selectedJourneyId={selectedJourneyId}
        onSelectJourney={setSelectedJourneyId}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onSelectSiteStop={(siteId) => selectSite(siteId, "list")}
      />

      {status === "error" && (
        <div
          role="alert"
          className="absolute right-3 top-3 z-10 max-w-sm rounded-lg bg-red-100 p-3 text-sm text-red-900 shadow md:left-[404px] md:right-auto"
        >
          {error}
        </div>
      )}
    </main>
  );
}
