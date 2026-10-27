import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  }));
}

export function badRequest(err: ZodError) {
  const issues = zodIssues(err);
  const summary = issues
    .map((i) => `${i.path || "body"}: ${i.message}`)
    .join("; ");
  return NextResponse.json(
    { ok: false, error: `Invalid request: ${summary}`, issues },
    { status: 400 },
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
