"use client";

import { useState } from "react";

type Image = { id: string; url: string; caption: string | null };

export default function SiteGallery({
  images,
  name,
}: {
  images: Image[];
  name: string;
}) {
  const [i, setI] = useState(0);
  const n = images.length;
  const cur = images[Math.min(i, n - 1)];
  const go = (d: number) => setI((x) => (x + d + n) % n);

  return (
    <figure
      aria-roledescription="carousel"
      aria-label={`Photos of ${name}`}
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowRight") go(1);
        else if (e.key === "ArrowLeft") go(-1);
      }}
    >
      <div className="group relative aspect-[4/3] overflow-hidden rounded-xl bg-stone-200">
        <a
          href={cur.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open full-size photo in a new tab"
          className="block h-full w-full"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host */}
          <img
            key={cur.id}
            src={cur.url}
            alt={cur.caption ?? `${name}, photo ${i + 1} of ${n}`}
            className="h-full w-full object-cover"
          />
        </a>
        {n > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 px-3 py-2 text-white backdrop-blur hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-white"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 px-3 py-2 text-white backdrop-blur hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-white"
            >
              ›
            </button>
            <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white">
              {Math.min(i, n - 1) + 1} / {n}
            </span>
          </>
        )}
      </div>

      {cur.caption && (
        <figcaption className="mt-2 text-sm text-stone-600">
          {cur.caption}
        </figcaption>
      )}

      {n > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {images.map((im, idx) => (
            <button
              key={im.id}
              type="button"
              onClick={() => setI(idx)}
              aria-label={`Show photo ${idx + 1} of ${n}`}
              aria-current={idx === i ? "true" : undefined}
              className={`h-14 w-20 shrink-0 overflow-hidden rounded-md ring-2 transition ${
                idx === i
                  ? "ring-amber-700"
                  : "opacity-70 ring-transparent hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host */}
              <img
                src={im.url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </figure>
  );
}
