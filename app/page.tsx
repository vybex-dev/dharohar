"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type {
  Map as MapLibreMap,
  Marker,
  StyleSpecification,
} from "maplibre-gl";

type SiteDto = {
  id: string;
  slug: string;
  name_en: string;
  category: string;
  state: string | null;
  district: string | null;
  summary_en: string;
  lat: number;
  lng: number;
  thumbnail_url: string | null;
};

type SitesResponse = { ok: boolean; sites?: SiteDto[]; error?: string };

// Default: OpenStreetMap's public raster tiles (light use only; see usage-policy notes).
// Override with NEXT_PUBLIC_MAP_STYLE_URL (a style JSON URL) to switch providers.
function buildStyle(): string | StyleSpecification {
  const custom = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
  if (custom) return custom;
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

// Built with DOM nodes + textContent (never HTML strings) so uploaded titles can't inject markup.
function buildPopupContent(site: SiteDto): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText =
    "width:230px;color:#111;font-family:system-ui,sans-serif";

  if (site.thumbnail_url) {
    const img = document.createElement("img");
    img.src = site.thumbnail_url;
    img.alt = site.name_en;
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
  return root;
}

export default function HomePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | null = null;
    const markers = new globalThis.Map<string, Marker>();

    async function init() {
      try {
        // Named exports only: the default export is undefined under Turbopack.
        const {
          Map,
          Marker,
          Popup,
          NavigationControl,
          LngLatBounds,
          setWorkerUrl,
        } = await import("maplibre-gl");
        if (disposed || !containerRef.current) return;

        // maplibre-gl 6.x uses a MODULE worker. Turbopack can't bundle it, so serve the
        // prebuilt worker (plus its shared chunk) from /public. Must run before new Map().
        setWorkerUrl(
          new URL("/maplibre-gl-worker.mjs", window.location.origin).href,
        );

        map = new Map({
          container: containerRef.current,
          style: buildStyle(),
          center: [75.5, 25.0], // Gujarat / Rajasthan
          zoom: 5,
        });
        map.addControl(new NavigationControl(), "top-right");

        const res = await fetch("/api/sites");
        const data = (await res.json()) as SitesResponse;
        if (disposed) return;
        if (!res.ok || !data.ok || !data.sites) {
          throw new Error(
            data.error ?? `Could not load sites (HTTP ${res.status})`,
          );
        }

        const bounds = new LngLatBounds();
        for (const site of data.sites) {
          const marker = new Marker({ color: "#b45309" })
            .setLngLat([site.lng, site.lat])
            .setPopup(
              new Popup({ offset: 24, maxWidth: "260px" }).setDOMContent(
                buildPopupContent(site),
              ),
            )
            .addTo(map);
          markers.set(site.id, marker);
          bounds.extend([site.lng, site.lat]);
        }
        setCount(data.sites.length);

        // Deep link from the upload page: /?site=<id>
        const wanted = new URLSearchParams(window.location.search).get("site");
        const target = wanted
          ? data.sites.find((s) => s.id === wanted)
          : undefined;
        if (target) {
          map.jumpTo({ center: [target.lng, target.lat], zoom: 13 });
          markers.get(target.id)?.togglePopup();
        } else if (data.sites.length > 0) {
          map.fitBounds(bounds, { padding: 70, maxZoom: 9, duration: 0 });
        }
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
      markers.forEach((m) => m.remove());
      map?.remove();
    };
  }, []);

  return (
    <main className="fixed inset-0">
      {/* maplibre adds its own positioning class to this node, so it fills a wrapper instead of being fixed itself */}
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute left-3 top-3 z-10 flex items-center gap-3 rounded-lg bg-white/95 px-3 py-2 text-black shadow">
        <span className="text-lg font-bold">Dharohar</span>
        <span className="text-xs text-gray-600">
          {status === "loading"
            ? "Loading…"
            : status === "ready"
              ? `${count} sites`
              : "Error"}
        </span>
        <Link
          href="/upload"
          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white"
        >
          + Add
        </Link>
      </div>

      {status === "error" && (
        <div
          role="alert"
          className="absolute left-3 right-3 top-16 z-10 rounded-lg bg-red-100 p-3 text-sm text-red-900 shadow"
        >
          {error}
        </div>
      )}
    </main>
  );
}
