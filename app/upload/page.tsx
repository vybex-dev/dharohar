"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  STAGES,
  STAGE_LABELS,
  progressPercent,
  type Stage,
} from "@/lib/pipeline";
import { getBrowserSupabase } from "@/lib/supabase";

type Phase =
  | "idle"
  | "requesting"
  | "uploading"
  | "processing"
  | "done"
  | "error";

type JobView = {
  id: string;
  stage: Stage;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  error: string | null;
  site_id: string | null;
};

type UploadApiResponse =
  | { ok: true; jobId: string; bucket: string; path: string; token: string }
  | { ok: false; error: string };

type AdvanceApiResponse = {
  ok: boolean;
  claimed?: boolean;
  stageError?: string;
  job?: JobView;
  error?: string;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// crypto.randomUUID() only exists on https/localhost. Phones testing over a LAN IP
// (http://192.168.x.x) need this fallback.
function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function validateFile(file: File): string | null {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `Unsupported file type "${file.type || "unknown"}". Use JPEG, PNG, WebP or PDF.`;
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`;
  }
  return null;
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [kind, setKind] = useState<"photo" | "scan">("photo");
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const previewUrl = useMemo(
    () =>
      file && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    [file],
  );
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const busy =
    phase === "requesting" || phase === "uploading" || phase === "processing";

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = ""; // allow picking the same file again
    if (!f) return;
    setFile(f);
    setKind(f.type === "application/pdf" ? "scan" : "photo");
    setError(null);
  }

  async function pump(jobId: string) {
    for (let i = 0; i < 80; i++) {
      if (!activeRef.current) return;

      const res = await fetch(`/api/jobs/${jobId}/advance`, { method: "POST" });
      const data = (await res.json()) as AdvanceApiResponse;
      if (!res.ok || !data.job)
        throw new Error(data.error ?? `Advance failed (HTTP ${res.status})`);

      setJob(data.job);
      setWarning(data.stageError ?? null);

      const j = data.job;
      if (j.stage === "published" && j.status === "done") {
        setPhase("done");
        return;
      }
      if (j.status === "failed" && j.attempts >= j.max_attempts) {
        throw new Error(
          `Stage "${STAGE_LABELS[j.stage]}" failed after ${j.attempts} attempts: ${j.error ?? "unknown error"}`,
        );
      }
      await sleep(data.stageError ? 1500 : data.claimed ? 250 : 1500);
    }
    throw new Error("Timed out waiting for processing to finish.");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file || busy) return;

    const problem = validateFile(file);
    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    setWarning(null);
    setJob(null);
    setPhase("requesting");

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: newUuid(),
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          kind,
          title: title.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const data = (await res.json()) as UploadApiResponse;
      if (!res.ok || !data.ok)
        throw new Error("error" in data ? data.error : `HTTP ${res.status}`);

      setPhase("uploading");
      const { error: upErr } = await getBrowserSupabase()
        .storage.from(data.bucket)
        .uploadToSignedUrl(data.path, data.token, file, {
          contentType: file.type,
        });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      setPhase("processing");
      await pump(data.jobId);
    } catch (err) {
      if (!activeRef.current) return;
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("error");
    }
  }

  function reset() {
    setFile(null);
    setTitle("");
    setNotes("");
    setKind("photo");
    setJob(null);
    setError(null);
    setWarning(null);
    setPhase("idle");
  }

  const currentIdx = job ? STAGES.indexOf(job.stage) : 0;
  const pct =
    phase === "done"
      ? 100
      : job
        ? progressPercent(job.stage, job.status)
        : phase === "uploading"
          ? 3
          : 0;

  return (
    <main className="mx-auto min-h-dvh max-w-lg p-4 pb-16">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Add a heritage record</h1>
        <Link href="/" className="text-sm text-blue-700 underline">
          Map
        </Link>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => cameraRef.current?.click()}
            className="rounded-lg bg-amber-700 px-4 py-3 text-base font-medium text-white disabled:opacity-50"
          >
            Take photo
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-gray-400 px-4 py-3 text-base font-medium disabled:opacity-50"
          >
            Choose file
          </button>
        </div>

        {/* capture="environment" opens the rear camera on phones; desktops ignore it */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={onPick}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ALLOWED_MIME_TYPES.join(",")}
          className="hidden"
          onChange={onPick}
        />

        {file && (
          <div className="flex items-center gap-3 rounded-lg border border-gray-300 p-3">
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Selected file preview"
                className="h-16 w-16 rounded object-cover"
              />
            )}
            <div className="min-w-0 text-sm">
              <div className="truncate font-medium">{file.name}</div>
              <div className="text-gray-600">
                {file.type || "unknown type"} ·{" "}
                {(file.size / 1048576).toFixed(2)} MB
              </div>
            </div>
          </div>
        )}

        <label className="block">
          <span className="text-sm font-medium">This is a</span>
          <select
            value={kind}
            disabled={busy || file?.type === "application/pdf"}
            onChange={(e) => setKind(e.target.value as "photo" | "scan")}
            className="mt-1 w-full rounded-lg border border-gray-400 bg-white px-3 py-3 text-base text-black"
          >
            <option value="photo">Photo of a site or object</option>
            <option value="scan">Scanned document</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Title (optional)</span>
          <input
            value={title}
            maxLength={200}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-400 bg-white px-3 py-3 text-base text-black"
            placeholder="e.g. Stepwell near Adalaj"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Notes (optional)</span>
          <textarea
            value={notes}
            maxLength={2000}
            rows={3}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-400 bg-white px-3 py-3 text-base text-black"
            placeholder="Anything you know about it"
          />
        </label>

        <button
          type="submit"
          disabled={!file || busy || phase === "done"}
          className="w-full rounded-lg bg-black px-4 py-3 text-base font-medium text-white disabled:opacity-40"
        >
          {phase === "requesting"
            ? "Preparing…"
            : phase === "uploading"
              ? "Uploading…"
              : phase === "processing"
                ? "Processing…"
                : "Upload"}
        </button>
      </form>

      {phase !== "idle" && (
        <section className="mt-6 space-y-3">
          <div className="h-3 w-full overflow-hidden rounded bg-gray-200">
            <div
              className={`h-full transition-all duration-300 ${phase === "error" ? "bg-red-500" : "bg-green-600"}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <ol className="space-y-1 text-sm">
            {STAGES.map((s, i) => {
              const done = phase === "done" || i < currentIdx;
              const active = phase === "processing" && i === currentIdx;
              return (
                <li
                  key={s}
                  className={
                    done
                      ? "text-green-700"
                      : active
                        ? "font-medium"
                        : "text-gray-500"
                  }
                >
                  {done ? "✓" : active ? "…" : "○"} {STAGE_LABELS[s]}
                </li>
              );
            })}
          </ol>

          {warning && phase === "processing" && (
            <p className="rounded bg-yellow-100 p-2 text-sm text-yellow-900">
              Retrying after an error: {warning}
            </p>
          )}

          {phase === "done" && (
            <div className="space-y-2 rounded-lg bg-green-100 p-3 text-green-900">
              <p className="font-medium">
                Published. Your record is on the map.
              </p>
              <div className="flex gap-4 text-sm">
                <Link
                  href={job?.site_id ? `/?site=${job.site_id}` : "/"}
                  className="font-medium underline"
                >
                  View on map
                </Link>
                <button type="button" onClick={reset} className="underline">
                  Upload another
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg bg-red-100 p-3 text-sm text-red-900"
        >
          {error}
          {phase === "error" && (
            <button type="button" onClick={reset} className="ml-3 underline">
              Start over
            </button>
          )}
        </div>
      )}
    </main>
  );
}
