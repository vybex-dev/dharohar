"use client";

import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  row?: { id: number; note: string; created_at: string } | null;
  extensions?: string[];
  missingExtensions?: string[];
  error?: string;
  stage?: string;
  hint?: string;
};

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as Health;
        if (!cancelled) setHealth(json);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setFetchError(e instanceof Error ? e.message : "Request failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = fetchError
    ? "error"
    : health === null
      ? "checking"
      : health.ok
        ? "ok"
        : "error";

  const color =
    status === "ok"
      ? "bg-green-100 text-green-800"
      : status === "checking"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Dharohar</h1>
      <p className="mt-1 text-gray-600">Phase 0: setup check</p>

      <div
        className={`mt-6 inline-block rounded px-3 py-1 text-sm font-medium ${color}`}
      >
        {status === "checking"
          ? "Checking…"
          : status === "ok"
            ? "Healthy"
            : "Problem"}
      </div>

      <pre className="mt-4 overflow-x-auto rounded bg-gray-900 p-4 text-sm text-gray-100">
        {JSON.stringify(fetchError ? { fetchError } : health, null, 2)}
      </pre>
    </main>
  );
}
