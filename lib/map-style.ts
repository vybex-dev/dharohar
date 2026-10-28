import type { StyleSpecification } from "maplibre-gl";

// Default: OpenStreetMap's public raster tiles (light use only; see usage-policy notes).
// Override with NEXT_PUBLIC_MAP_STYLE_URL (a style JSON URL) to switch providers.
export function buildStyle(): string | StyleSpecification {
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

// maplibre-gl 6.x uses a MODULE worker. Turbopack can't bundle it, so the prebuilt worker
// (plus its shared chunk) is served from /public. Call before the first `new Map()`.
export function workerUrl(): string {
  return new URL("/maplibre-gl-worker.mjs", window.location.origin).href;
}
