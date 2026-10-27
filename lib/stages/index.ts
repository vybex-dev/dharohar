import type { RunnableStage } from "@/lib/pipeline";
import type { StageHandler } from "./types";
import { embedStage } from "./embed";
import { extractStage } from "./extract";
import { geocodeStage } from "./geocode";
import { ocrStage } from "./ocr";
import { uploadedStage } from "./uploaded";

export const STAGE_HANDLERS: Record<RunnableStage, StageHandler> = {
  uploaded: uploadedStage,
  ocr: ocrStage,
  extract: extractStage,
  geocode: geocodeStage,
  embed: embedStage,
};
