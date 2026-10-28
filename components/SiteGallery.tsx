"use client";

import { useState } from "react";

type Image = { id: string; url: string; caption: string | null };

export default function SiteGallery({
  images,
  name,
  summary,
}: {
  images: Image[];
  name: string;
  summary?: string | null;
}) {
  const [i, setI] = useState(0);
  const n = images.length;
  const cur = images[Math.min(i, n - 1)];
  const go = (d: number) => setI((x) => (x + d + n) % n);

  const mainAltText =
    cur.caption ||
    (summary
      ? `${name}: ${summary.slice(0, 110)}`
      : `${name}, photo ${i + 1} of ${n}`);

  return (
    <figure
      aria-roledescription="carousel"
      aria-label={`Photos of ${name}`}
      tabIndex={0}
      className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 rounded-xl"
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowRight") go(1);
        else if (e.key === "ArrowLeft") go(-1);
      }}
    >
      <div className="group relative aspect-[4/3] overflow-hidden rounded-xl bg-stone-200 shadow-sm">
        <a
          href={cur.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open full-size photo in a new tab: ${mainAltText}`}
          className="block h-full w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host */}
          <img
            key={cur.id}
            src={cur.url}
            alt={mainAltText}
            className="h-full w-full object-cover"
          />
        </a>
        {n > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/65 px-3.5 py-2 text-white backdrop-blur hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-white"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/65 px-3.5 py-2 text-white backdrop-blur hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-white"
            >
              ›
            </button>
            <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2.5 py-0.5 text-[11px] font-medium text-white shadow">
              {Math.min(i, n - 1) + 1} / {n}
            </span>
          </>
        )}
      </div>

      {cur.caption && (
        <figcaption className="mt-2 text-sm text-stone-700">
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
              className={`h-14 w-20 shrink-0 overflow-hidden rounded-md ring-2 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 ${
                idx === i
                  ? "ring-amber-800"
                  : "opacity-75 ring-transparent hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host */}
              <img
                src={im.url}
                alt={`${name} thumbnail ${idx + 1}`}
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
