import type { StageHandler } from "./types";

export const ocrStage: StageHandler = async ({ db, asset }) => {
  const label =
    asset.title?.trim() || asset.original_filename || "untitled upload";
  const ocrText =
    "[STUB OCR] यह एक नमूना पाठ है। वास्तविक OCR बाद में जोड़ा जाएगा।";
  const textEn =
    `[STUB] Sample text for "${label}".` +
    (asset.notes ? ` Notes: ${asset.notes}` : "") +
    " Real OCR and translation will replace this.";

  const { error } = await db
    .from("assets")
    .update({
      ocr_text: ocrText,
      text_en: textEn,
      language_detected: "hi",
      ocr_provider: "stub",
      ocr_model: "stub",
      ocr_confidence: 0.5,
    })
    .eq("id", asset.id);
  if (error) throw new Error(`Could not save OCR result: ${error.message}`);

  return {
    output: { language: "hi", chars: ocrText.length, stub: true },
    provider: "stub",
    model: "stub",
  };
};
