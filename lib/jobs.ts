// lib/jobs.ts
import type { JobRow } from "@/lib/stages/types";

export const JOB_COLUMNS =
  "id, asset_id, site_id, stage, status, attempts, max_attempts, locked_at, error, created_at, updated_at";

export function jobView(j: JobRow) {
  return {
    id: j.id,
    stage: j.stage,
    status: j.status,
    attempts: j.attempts,
    max_attempts: j.max_attempts,
    error: j.error,
    site_id: j.site_id,
  };
}
