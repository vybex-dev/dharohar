"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { buildStyle, workerUrl } from "@/lib/map-style";

export default function SiteMapSnippet({
  id,
  name,
  lat,
  lng,
}: {
  id: string;
  name: string;
  lat: number;
  lng: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const lib = await import("maplibre-gl");
        if (disposed || !ref.current) return;
        lib.setWorkerUrl(workerUrl());
        const map = new lib.Map({
          container: ref.current,
          style: buildStyle(),
          center: [lng, lat],
          zoom: 11,
          interactive: false, // a snippet: the full map is one click away
          attributionControl: { compact: true },
        });
        const marker = new lib.Marker({ color: "#b45309" })
          .setLngLat([lng, lat])
          .addTo(map);
        cleanup = () => {
          marker.remove();
          map.remove();
        };
      } catch {
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [lat, lng]);

  return (
    <div>
      <div
        role="img"
        aria-label={`Map showing the location of ${name}`}
        className="relative h-56 overflow-hidden rounded-xl bg-stone-200"
      >
        <div ref={ref} className="h-full w-full" />
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-stone-500">
            Map unavailable
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-stone-500">
        <span className="tabular-nums">
          {lat.toFixed(4)}, {lng.toFixed(4)}
        </span>
        <Link
          href={`/?site=${id}`}
          className="font-medium text-amber-800 underline-offset-2 hover:underline"
        >
          Open on the full map →
        </Link>
      </div>
    </div>
  );
}
