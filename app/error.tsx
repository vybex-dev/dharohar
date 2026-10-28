"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[RootError]", error);
  }, [error]);

  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center bg-stone-50 px-6 py-12 text-center text-stone-900"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-2xl text-amber-800 shadow-inner">
        ⚠️
      </div>
      <h1 className="mt-4 font-serif text-3xl font-bold tracking-tight text-stone-900 sm:text-4xl">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-stone-600">
        We encountered an unexpected error while loading this page.
        {error.digest && (
          <span className="block mt-1 text-xs text-stone-500">
            Error digest: <code>{error.digest}</code>
          </span>
        )}
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg bg-amber-800 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800"
        >
          Return to Heritage Map
        </Link>
      </div>
    </div>
  );
}
