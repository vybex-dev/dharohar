"use client";

import Link from "next/link";

export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center bg-stone-50 px-6 text-center text-stone-900"
    >
      <h1 className="font-serif text-3xl font-semibold">
        Couldn’t load this site
      </h1>
      <p className="mt-2 max-w-sm text-sm text-stone-600">
        Something went wrong while reading the record
        {error.digest ? ` (ref ${error.digest})` : ""}.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-stone-900 px-4 py-2 text-sm font-medium text-white"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white"
        >
          Back to the map
        </Link>
      </div>
    </div>
  );
}
