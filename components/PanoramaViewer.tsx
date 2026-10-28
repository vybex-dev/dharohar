"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PanoramaHotspot, PanoramaItem } from "@/lib/site-detail";

type Props = {
  panorama: PanoramaItem;
  siteName: string;
};

// Global typing for Pannellum
declare global {
  interface Window {
    pannellum?: {
      viewer: (
        elementId: string | HTMLElement,
        config: Record<string, unknown>,
      ) => {
        destroy: () => void;
        lookAt: (
          pitch: number,
          yaw: number,
          hfov?: number,
          animated?: boolean | number,
        ) => void;
        getPitch: () => number;
        getYaw: () => number;
        getHfov: () => number;
        setHfov: (hfov: number) => void;
        stopAutoRotate: () => void;
        startAutoRotate: (speed?: number) => void;
        toggleFullscreen: () => void;
      };
    };
  }
}

export default function PanoramaViewer({ panorama, siteName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeSpot, setActiveSpot] = useState<PanoramaHotspot | null>(
    panorama.hotspots[0] ?? null,
  );
  const [pitch, setPitch] = useState<number>(0);
  const [yaw, setYaw] = useState<number>(0);
  const [hfov, setHfov] = useState<number>(90);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [pannellumReady, setPannellumReady] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const viewerInstanceRef = useRef<{
    destroy: () => void;
    lookAt: (
      pitch: number,
      yaw: number,
      hfov?: number,
      animated?: boolean | number,
    ) => void;
    setHfov: (hfov: number) => void;
    stopAutoRotate: () => void;
    startAutoRotate: (speed?: number) => void;
    toggleFullscreen: () => void;
  } | null>(null);

  const draggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const animFrameRef = useRef<number | null>(null);

  // Load Pannellum scripts dynamically if not present
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (window.pannellum) {
      setPannellumReady(true);
      return;
    }

    const cssId = "pannellum-css";
    if (!document.getElementById(cssId)) {
      const link = document.createElement("link");
      link.id = cssId;
      link.rel = "stylesheet";
      link.href =
        "https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css";
      document.head.appendChild(link);
    }

    const scriptId = "pannellum-js";
    if (!document.getElementById(scriptId)) {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src =
        "https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js";
      script.async = true;
      script.onload = () => setPannellumReady(true);
      script.onerror = () => {
        // Pannellum CDN blocked or offline -> fallback to built-in canvas sphere projection
        setPannellumReady(false);
        setLoading(false);
      };
      document.head.appendChild(script);
    }
  }, []);

  // Initialize Pannellum if available
  useEffect(() => {
    if (!pannellumReady || !window.pannellum || !containerRef.current) return;

    const panoId = `pano-box-${panorama.id}`;
    let el = document.getElementById(panoId);
    if (!el && containerRef.current) {
      el = document.createElement("div");
      el.id = panoId;
      el.style.width = "100%";
      el.style.height = "100%";
      containerRef.current.innerHTML = "";
      containerRef.current.appendChild(el);
    }
    if (!el) return;

    try {
      const viewer = window.pannellum.viewer(el, {
        type: "equirectangular",
        panorama: panorama.url,
        autoLoad: true,
        autoRotate: autoRotate ? -1.5 : 0,
        compass: true,
        showZoomCtrl: false,
        showFullscreenCtrl: false,
        hotSpotDebug: false,
        hotSpots: panorama.hotspots.map((spot) => ({
          pitch: spot.pitch,
          yaw: spot.yaw,
          type: "info",
          text: spot.title,
          clickHandlerFunc: () => {
            setActiveSpot(spot);
          },
        })),
      });

      viewerInstanceRef.current = viewer;
      setLoading(false);

      return () => {
        try {
          viewer.destroy();
        } catch {
          // ignore cleanup errors
        }
        viewerInstanceRef.current = null;
      };
    } catch (err) {
      console.warn("[PanoramaViewer] Pannellum init error, falling back to canvas:", err);
      setPannellumReady(false);
    }
  }, [pannellumReady, panorama.id, panorama.url, panorama.hotspots, autoRotate]);

  // Built-in Canvas Fallback (works 100% offline or when CDN is unreachable)
  useEffect(() => {
    if (pannellumReady) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let isCancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = panorama.url;

    img.onload = () => {
      if (isCancelled) return;
      setLoading(false);

      const render = () => {
        if (!canvas || !ctx) return;
        const w = (canvas.width = canvas.clientWidth || 800);
        const h = (canvas.height = canvas.clientHeight || 450);

        // Clear canvas
        ctx.fillStyle = "#1c1917";
        ctx.fillRect(0, 0, w, h);

        // Calculate equirectangular slice window based on current yaw (-180 to 180) and pitch (-90 to 90)
        const normYaw = (((yaw + 180) % 360) + 360) % 360; // 0 to 360
        const srcX = (normYaw / 360) * img.width;
        const viewWidth = (hfov / 360) * img.width;
        const viewHeight = (viewWidth * h) / w;
        const normPitch = Math.max(-60, Math.min(60, pitch));
        const srcY =
          ((90 - normPitch) / 180) * img.height - viewHeight / 2;

        // Draw image wrap around
        ctx.save();
        if (srcX + viewWidth <= img.width) {
          ctx.drawImage(
            img,
            srcX,
            Math.max(0, srcY),
            viewWidth,
            viewHeight,
            0,
            0,
            w,
            h,
          );
        } else {
          const firstPart = img.width - srcX;
          const firstDestW = (firstPart / viewWidth) * w;
          ctx.drawImage(
            img,
            srcX,
            Math.max(0, srcY),
            firstPart,
            viewHeight,
            0,
            0,
            firstDestW,
            h,
          );
          ctx.drawImage(
            img,
            0,
            Math.max(0, srcY),
            viewWidth - firstPart,
            viewHeight,
            firstDestW,
            0,
            w - firstDestW,
            h,
          );
        }
        ctx.restore();

        // Render Hotspots on Canvas
        for (const spot of panorama.hotspots) {
          let relYaw = spot.yaw - yaw;
          while (relYaw > 180) relYaw -= 360;
          while (relYaw < -180) relYaw += 360;

          if (Math.abs(relYaw) <= hfov / 2) {
            const screenX = (0.5 + relYaw / hfov) * w;
            const relPitch = spot.pitch - pitch;
            const vfov = (hfov * h) / w;
            const screenY = (0.5 - relPitch / vfov) * h;

            if (screenX >= 20 && screenX <= w - 20 && screenY >= 20 && screenY <= h - 20) {
              const isSelected = activeSpot?.id === spot.id;
              // Pulsing circle
              ctx.beginPath();
              ctx.arc(screenX, screenY, isSelected ? 14 : 10, 0, 2 * Math.PI);
              ctx.fillStyle = isSelected
                ? "rgba(217, 119, 6, 0.9)"
                : "rgba(255, 255, 255, 0.85)";
              ctx.fill();
              ctx.lineWidth = 2;
              ctx.strokeStyle = isSelected ? "#ffffff" : "#b45309";
              ctx.stroke();

              // Tooltip badge
              ctx.font = "600 11px system-ui, sans-serif";
              const textWidth = ctx.measureText(spot.title).width;
              ctx.fillStyle = "rgba(28, 25, 23, 0.85)";
              ctx.fillRect(screenX - textWidth / 2 - 6, screenY - 26, textWidth + 12, 18);
              ctx.fillStyle = "#ffffff";
              ctx.fillText(spot.title, screenX - textWidth / 2, screenY - 13);
            }
          }
        }

        if (autoRotate) {
          setYaw((y) => (y + 0.15) % 360);
        }
        animFrameRef.current = requestAnimationFrame(render);
      };

      animFrameRef.current = requestAnimationFrame(render);
    };

    return () => {
      isCancelled = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [pannellumReady, panorama.url, panorama.hotspots, yaw, pitch, hfov, autoRotate, activeSpot]);

  // Navigate viewer to a specific hotspot
  const lookAtSpot = useCallback(
    (spot: PanoramaHotspot) => {
      setActiveSpot(spot);
      if (viewerInstanceRef.current) {
        viewerInstanceRef.current.lookAt(spot.pitch, spot.yaw, 85, 1000);
      } else {
        setPitch(spot.pitch);
        setYaw(spot.yaw);
        setHfov(85);
      }
    },
    [],
  );

  // Keyboard navigation for accessibility
  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        setYaw((y) => y - 10);
        break;
      case "ArrowRight":
        e.preventDefault();
        setYaw((y) => y + 10);
        break;
      case "ArrowUp":
        e.preventDefault();
        setPitch((p) => Math.min(60, p + 8));
        break;
      case "ArrowDown":
        e.preventDefault();
        setPitch((p) => Math.max(-60, p - 8));
        break;
      case "+":
      case "=":
        e.preventDefault();
        zoomIn();
        break;
      case "-":
      case "_":
        e.preventDefault();
        zoomOut();
        break;
    }
  };

  const zoomIn = () => {
    const next = Math.max(50, hfov - 15);
    setHfov(next);
    viewerInstanceRef.current?.setHfov(next);
  };

  const zoomOut = () => {
    const next = Math.min(115, hfov + 15);
    setHfov(next);
    viewerInstanceRef.current?.setHfov(next);
  };

  const toggleAutoRotate = () => {
    const next = !autoRotate;
    setAutoRotate(next);
    if (viewerInstanceRef.current) {
      if (next) viewerInstanceRef.current.startAutoRotate(-1.5);
      else viewerInstanceRef.current.stopAutoRotate();
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Mouse drag handlers for canvas fallback
  const onMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = true;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    if (autoRotate) setAutoRotate(false);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    setYaw((y) => y - dx * 0.35);
    setPitch((p) => Math.max(-60, Math.min(60, p + dy * 0.35)));
  };

  const onMouseUp = () => {
    draggingRef.current = false;
  };

  return (
    <section
      aria-label={`360-degree interactive panorama of ${siteName}`}
      className="space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-800 text-xs font-bold text-white shadow-sm">
            360°
          </span>
          <h2 className="text-lg font-semibold tracking-tight text-stone-900">
            Interactive Panorama
          </h2>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            Equirectangular
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-stone-600">
          <span className="hidden sm:inline">Use mouse or arrows to look around</span>
        </div>
      </div>

      {/* Main 360 Viewer Shell */}
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label="360 Panorama Viewer. Focus and use arrow keys to pan, plus and minus keys to zoom."
        className="group relative h-[380px] w-full overflow-hidden rounded-xl bg-stone-900 text-white shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 sm:h-[460px]"
      >
        {/* Loading Indicator */}
        {loading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-stone-900/80 backdrop-blur-sm">
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-amber-600 border-t-transparent" />
            <span className="mt-3 text-xs font-medium text-stone-300">
              Loading 360° Sphere...
            </span>
          </div>
        )}

        {/* Built-in fallback canvas when Pannellum isn't active */}
        {!pannellumReady && (
          <canvas
            ref={canvasRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            className="h-full w-full cursor-grab active:cursor-grabbing"
          />
        )}

        {/* On-screen Controls Overlay */}
        <div className="absolute right-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg bg-black/60 p-1 backdrop-blur-sm">
          <button
            type="button"
            onClick={zoomIn}
            aria-label="Zoom in"
            title="Zoom in (+)"
            className="flex h-8 w-8 items-center justify-center rounded bg-stone-800/80 text-lg font-bold text-white hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-white"
          >
            +
          </button>
          <button
            type="button"
            onClick={zoomOut}
            aria-label="Zoom out"
            title="Zoom out (-)"
            className="flex h-8 w-8 items-center justify-center rounded bg-stone-800/80 text-lg font-bold text-white hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-white"
          >
            −
          </button>
          <button
            type="button"
            onClick={toggleAutoRotate}
            aria-label={autoRotate ? "Pause auto-rotation" : "Start auto-rotation"}
            title="Toggle rotation"
            className={`flex h-8 w-8 items-center justify-center rounded text-xs font-semibold focus-visible:outline-2 focus-visible:outline-white ${
              autoRotate ? "bg-amber-600 text-white" : "bg-stone-800/80 text-stone-300 hover:bg-amber-700"
            }`}
          >
            {autoRotate ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title="Fullscreen"
            className="flex h-8 w-8 items-center justify-center rounded bg-stone-800/80 text-xs text-white hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-white"
          >
            ⛶
          </button>
        </div>

        {/* Hotspot Floating Note Card Overlay */}
        {activeSpot && (
          <div
            role="dialog"
            aria-label={activeSpot.title}
            className="absolute bottom-3 left-3 right-3 z-10 max-w-md rounded-lg border border-amber-600/40 bg-stone-900/95 p-3.5 text-stone-100 shadow-2xl backdrop-blur-md sm:bottom-4 sm:left-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                <h3 className="text-sm font-semibold text-amber-400">
                  {activeSpot.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setActiveSpot(null)}
                aria-label="Close note"
                className="rounded p-0.5 text-stone-400 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                ✕
              </button>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-stone-300">
              {activeSpot.text}
            </p>
          </div>
        )}
      </div>

      {/* Hotspots Linking to Notes (Accessible List & Selector) */}
      {panorama.hotspots.length > 0 && (
        <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">
              Hotspots linked to notes ({panorama.hotspots.length})
            </span>
            <span className="text-xs text-stone-500">
              Click a note to center the view
            </span>
          </div>

          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {panorama.hotspots.map((spot) => {
              const isSelected = activeSpot?.id === spot.id;
              return (
                <button
                  key={spot.id}
                  type="button"
                  onClick={() => lookAtSpot(spot)}
                  aria-pressed={isSelected}
                  className={`flex flex-col items-start rounded-lg border p-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 ${
                    isSelected
                      ? "border-amber-600 bg-amber-50/80 ring-1 ring-amber-600"
                      : "border-stone-200 bg-stone-50/60 hover:border-amber-400 hover:bg-stone-50"
                  }`}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-xs font-semibold text-stone-900">
                      📍 {spot.title}
                    </span>
                    <span className="text-[10px] text-stone-500">
                      Yaw: {spot.yaw}°
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-stone-600">
                    {spot.text}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {panorama.caption && (
        <p className="text-xs italic text-stone-500">{panorama.caption}</p>
      )}
    </section>
  );
}
