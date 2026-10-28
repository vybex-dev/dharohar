"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { buildStyle, workerUrl } from "@/lib/map-style";
import type { LatLng } from "@/lib/review-fields";

const INDIA_CENTER: [number, number] = [78.9629, 20.5937];
const PIN_COLOR = "#b45309";

function round6(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * A map with ONE draggable pin. Click the map to place or move it, or drag it.
 * `value` is the source of truth: when it changes from outside (typed
 * coordinates, "reset"), the pin follows. Pointer-only by itself; the review
 * page also offers latitude/longitude inputs as the keyboard route.
 */
export default function PinPicker({
  value,
  onChange,
}: {
  value: LatLng | null;
  onChange: (p: LatLng) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const onChangeRef = useRef(onChange);
  const startRef = useRef(value); // only the first value is used, to centre the initial view
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Create the map once.
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const lib = await import("maplibre-gl");
        if (disposed || !containerRef.current) return;
        lib.setWorkerUrl(workerUrl());
        const start = startRef.current;
        const map = new lib.Map({
          container: containerRef.current,
          style: buildStyle(),
          center: start ? [start.lng, start.lat] : INDIA_CENTER,
          zoom: start ? 13 : 4,
          attributionControl: { compact: true },
        });
        map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
        map.on("click", (e) => {
          onChangeRef.current({
            lat: round6(e.lngLat.lat),
            lng: round6(e.lngLat.lng),
          });
        });
        libRef.current = lib;
        mapRef.current = map;
        setReady(true);
      } catch (err) {
        console.error("[PinPicker]", err);
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      libRef.current = null;
    };
  }, []);

  // Keep the pin in step with `value`.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;

    if (value === null) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const marker = new lib.Marker({ color: PIN_COLOR, draggable: true })
        .setLngLat([value.lng, value.lat])
        .addTo(map);
      marker.on("dragend", () => {
        const p = marker.getLngLat();
        onChangeRef.current({ lat: round6(p.lat), lng: round6(p.lng) });
      });
      markerRef.current = marker;
      map.easeTo({ center: [value.lng, value.lat], zoom: Math.max(map.getZoom(), 12) });
      return;
    }
    const at = markerRef.current.getLngLat();
    if (Math.abs(at.lat - value.lat) > 1e-7 || Math.abs(at.lng - value.lng) > 1e-7) {
      markerRef.current.setLngLat([value.lng, value.lat]);
      if (!map.getBounds().contains([value.lng, value.lat])) {
        map.easeTo({ center: [value.lng, value.lat] });
      }
    }
  }, [value, ready]);

  return (
    <div
      role="application"
      aria-label="Map. Click to place the pin, or drag the pin to move it."
      className="relative h-72 overflow-hidden rounded-xl bg-stone-200 sm:h-80"
    >
      <div ref={containerRef} className="h-full w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-stone-600">
          The map could not load. You can still type the coordinates below.
        </div>
      )}
    </div>
  );
}
