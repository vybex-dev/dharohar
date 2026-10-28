import type { SupabaseClient } from "@supabase/supabase-js";
import type { Stage } from "@/lib/pipeline";

export type JobRow = {
  id: string;
  asset_id: string;
  site_id: string | null;
  stage: Stage;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type AssetRow = {
  id: string;
  site_id: string | null;
  kind: "photo" | "scan" | "pano";
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  title: string | null;
  notes: string | null;
  content_hash: string | null;
  language_detected: string | null;
  ocr_text: string | null;
  ocr_confidence: number | null;
  text_en: string | null;
};

export type StageResult = {
  output: Record<string, unknown>;
  provider?: string;
  model?: string;
};

export type StageContext = {
  db: SupabaseClient;
  job: JobRow;
  asset: AssetRow;
};

/** A handler must be safe to run twice: same inputs, same DB end state. */
export type StageHandler = (ctx: StageContext) => Promise<StageResult>;
