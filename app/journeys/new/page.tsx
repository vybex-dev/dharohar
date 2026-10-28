"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { buildStyle, workerUrl } from "@/lib/map-style";
import type { SiteDto } from "@/lib/facets";

type MapLibre = typeof import("maplibre-gl");
type LngLat = [number, number];

const COLOR_OPTIONS = [
  { label: "Amber Gold", hex: "#b45309" },
  { label: "Emerald Green", hex: "#047857" },
  { label: "Indigo Royal", hex: "#4338ca" },
  { label: "Crimson Rose", hex: "#be123c" },
  { label: "Desert Teal", hex: "#0f766e" },
  { label: "Ochre Earth", hex: "#c2410c" },
];

function calculateDistanceKm(points: LngLat[]): number {
  if (points.length < 2) return 0;
  let totalMeters = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [lon1, lat1] = points[i];
    const [lon2, lat2] = points[i + 1];
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) *
        Math.cos(phi2) *
        Math.sin(deltaLambda / 2) *
        Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    totalMeters += R * c;
  }
  return Math.round((totalMeters / 1000) * 10) / 10;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export default function NewJourneyPage() {
  const router = useRouter();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<MapLibre | null>(null);
  const waypointsMarkersRef = useRef<Marker[]>([]);

  // Form states
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [era, setEra] = useState("");
  const [description, setDescription] = useState("");
  const [tagsStr, setTagsStr] = useState("");
  const [color, setColor] = useState("#b45309");

  // Route drawing states
  const [waypoints, setWaypoints] = useState<LngLat[]>([]);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [allSites, setAllSites] = useState<SiteDto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Sync slug with title until user manually edits it
  useEffect(() => {
    if (!slugTouched) {
      setSlug(slugify(title));
    }
  }, [title, slugTouched]);

  // Load existing heritage sites so user can click to snap/attach them to journey
  useEffect(() => {
    fetch("/api/sites")
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.sites)) {
          setAllSites(data.sites);
        }
      })
      .catch(() => {});
  }, []);

  // Initialize MapLibre
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const lib = await import("maplibre-gl");
      if (cancelled || !mapContainerRef.current) return;
      libRef.current = lib;
      lib.setWorkerUrl(workerUrl());

      const map = new lib.Map({
        container: mapContainerRef.current,
        style: buildStyle(),
        center: [72.5714, 23.0225], // Gujarat center
        zoom: 7,
      });

      map.addControl(new lib.NavigationControl(), "top-right");

      map.on("load", () => {
        if (cancelled) return;
        mapRef.current = map;
        setMapLoaded(true);

        // Add line source & layer for the journey route
        map.addSource("journey-draw-route", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [],
            },
          },
        });

        // Translucent casing
        map.addLayer({
          id: "journey-draw-casing",
          type: "line",
          source: "journey-draw-route",
          paint: {
            "line-color": color,
            "line-width": 8,
            "line-opacity": 0.35,
          },
        });

        // Solid route line
        map.addLayer({
          id: "journey-draw-line",
          type: "line",
          source: "journey-draw-route",
          paint: {
            "line-color": color,
            "line-width": 4,
            "line-opacity": 0.95,
          },
        });

        // Click map to append waypoint
        map.on("click", (e) => {
          const lngLat: LngLat = [
            Math.round(e.lngLat.lng * 10000) / 10000,
            Math.round(e.lngLat.lat * 10000) / 10000,
          ];
          setWaypoints((prev) => [...prev, lngLat]);
        });
      });
    }

    init();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
    };
  }, []);

  // Update route line on map whenever waypoints change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const source = map.getSource("journey-draw-route") as
      | { setData: (data: GeoJSON.Feature) => void }
      | undefined;

    if (source) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: waypoints,
        },
      });
    }

    // Update layer colors
    if (map.getLayer("journey-draw-casing")) {
      map.setPaintProperty("journey-draw-casing", "line-color", color);
    }
    if (map.getLayer("journey-draw-line")) {
      map.setPaintProperty("journey-draw-line", "line-color", color);
    }

    // Clear old waypoint markers
    for (const m of waypointsMarkersRef.current) m.remove();
    waypointsMarkersRef.current = [];

    // Add numbered pin for each waypoint
    const lib = libRef.current;
    if (!lib) return;

    waypoints.forEach(([lng, lat], idx) => {
      const el = document.createElement("div");
      el.className =
        "flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-white shadow-md transition transform hover:scale-110";
      el.style.backgroundColor = color;
      el.textContent = String(idx + 1);

      const marker = new lib.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(map);

      waypointsMarkersRef.current.push(marker);
    });
  }, [waypoints, color, mapLoaded]);

  // Display existing sites on the map as clickable stops
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !mapLoaded || allSites.length === 0) return;

    const markers: Marker[] = [];
    for (const site of allSites) {
      const el = document.createElement("div");
      el.className =
        "cursor-pointer rounded-md bg-stone-900/80 px-2 py-1 text-[10px] font-medium text-amber-200 shadow ring-1 ring-white/30 backdrop-blur-sm hover:bg-amber-800 hover:text-white";
      el.textContent = `📍 ${site.name_en}`;
      el.title = `Click to add ${site.name_en} to this journey`;

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const pt: LngLat = [site.lng, site.lat];
        setWaypoints((prev) => [...prev, pt]);
        setSelectedSiteIds((prev) =>
          prev.includes(site.id) ? prev : [...prev, site.id],
        );
      });

      const m = new lib.Marker({ element: el })
        .setLngLat([site.lng, site.lat])
        .addTo(map);
      markers.push(m);
    }

    return () => {
      for (const m of markers) m.remove();
    };
  }, [allSites, mapLoaded]);

  const undoLastPoint = () => {
    setWaypoints((prev) => prev.slice(0, -1));
  };

  const clearRoute = () => {
    setWaypoints([]);
    setSelectedSiteIds([]);
  };

  const reverseRoute = () => {
    setWaypoints((prev) => [...prev].reverse());
    setSelectedSiteIds((prev) => [...prev].reverse());
  };

  const distanceKm = calculateDistanceKm(waypoints);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (waypoints.length < 2) {
      setError("Please click on the map to add at least 2 points for the journey route.");
      return;
    }

    if (!title.trim() || !slug.trim()) {
      setError("Title and slug are required.");
      return;
    }

    setSubmitting(true);
    try {
      const tags = tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await fetch("/api/journeys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          slug: slug.trim(),
          era: era.trim() || undefined,
          description: description.trim() || undefined,
          tags,
          color,
          coordinates: waypoints,
          siteIds: selectedSiteIds,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Failed to save journey (HTTP ${res.status})`);
      }

      // Success: return to home map viewing new journey
      router.push(`/?journey=${data.journey.slug}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-stone-50 text-stone-900 md:flex-row">
      {/* Left/Sidebar Form */}
      <div className="flex flex-col border-b border-stone-200 bg-white shadow-lg md:h-full md:w-[460px] md:border-b-0 md:border-r">
        {/* Header */}
        <div className="border-b border-stone-200 px-6 py-4">
          <nav aria-label="Breadcrumb" className="mb-1 text-xs">
            <Link
              href="/"
              className="font-medium text-amber-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-amber-700"
            >
              ← Back to Atlas
            </Link>
          </nav>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-stone-900">
            Draw a Heritage Journey
          </h1>
          <p className="mt-1 text-xs text-stone-600">
            Click on the map or click existing heritage site markers to trace a
            historical linestring circuit.
          </p>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={handleSubmit}
          className="flex-1 space-y-4 overflow-y-auto px-6 py-4"
        >
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
            >
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-700">
              Journey Title *
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Solanki Stepwell & Temple Corridor"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-stone-700">
                Slug (URL key) *
              </label>
              <input
                type="text"
                required
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-stone-700">
                Historical Era
              </label>
              <input
                type="text"
                value={era}
                onChange={(e) => setEra(e.target.value)}
                placeholder="e.g. 11th-13th century"
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-700">
              Route Theme Color
            </label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => setColor(c.hex)}
                  aria-label={c.label}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                    color === c.hex
                      ? "border-stone-900 bg-stone-900 text-white shadow"
                      : "border-stone-300 bg-white text-stone-700 hover:border-stone-400"
                  }`}
                >
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: c.hex }}
                  />
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-700">
              Description &amp; Narrative
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell the story of this travel route, dynasty history, or architectural connection..."
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-700">
              Tags (comma separated)
            </label>
            <input
              type="text"
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="stepwell, unesco, solanki, pilgrim-route"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-700"
            />
          </div>

          {/* Waypoints & Distance Summary */}
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-700">
                Waypoints Plotted: {waypoints.length}
              </span>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">
                {distanceKm} km total
              </span>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={undoLastPoint}
                disabled={waypoints.length === 0}
                className="flex-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 shadow-sm hover:bg-stone-50 disabled:opacity-40"
              >
                ↺ Undo Last
              </button>
              <button
                type="button"
                onClick={reverseRoute}
                disabled={waypoints.length < 2}
                className="flex-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 shadow-sm hover:bg-stone-50 disabled:opacity-40"
              >
                ⇄ Reverse
              </button>
              <button
                type="button"
                onClick={clearRoute}
                disabled={waypoints.length === 0}
                className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
              >
                Clear
              </button>
            </div>

            {waypoints.length > 0 && (
              <ol className="mt-3 max-h-36 space-y-1 overflow-y-auto text-xs text-stone-600">
                {waypoints.map(([lng, lat], i) => (
                  <li key={`${lng}-${lat}-${i}`} className="flex items-center gap-2">
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                      style={{ backgroundColor: color }}
                    >
                      {i + 1}
                    </span>
                    <span>
                      {lat.toFixed(4)}°N, {lng.toFixed(4)}°E
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting || waypoints.length < 2}
            className="w-full rounded-lg bg-amber-800 py-3 text-sm font-semibold text-white shadow transition hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800 disabled:opacity-50"
          >
            {submitting ? "Publishing Journey..." : "Publish Journey Route"}
          </button>
        </form>
      </div>

      {/* Right Map Canvas */}
      <div className="relative flex-1">
        <div ref={mapContainerRef} className="h-full w-full min-h-[400px]" />

        {/* Floating Drawing Helper Hint */}
        <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-sm rounded-lg bg-stone-900/85 p-3 text-xs text-white shadow-xl backdrop-blur-md">
          <p className="font-semibold text-amber-400">Drawing mode active</p>
          <p className="mt-1 leading-relaxed text-stone-200">
            Click anywhere on the map to add route points. Click site pills (📍)
            to link heritage stops.
          </p>
        </div>
      </div>
    </div>
  );
}
