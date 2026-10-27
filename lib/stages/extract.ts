import type { StageHandler } from "./types";

export const extractStage: StageHandler = async ({ db, job, asset }) => {
  const name = asset.title?.trim() || `Untitled upload ${asset.id.slice(0, 8)}`;
  const summary =
    asset.text_en ??
    `[STUB] No text available for ${name}. Extraction will be added later.`;

  const extracted = {
    name_en: name,
    name_local: null,
    category: "other",
    state: null,
    district: null,
    period: null,
    tags: ["upload", "stub"],
    summary_en: summary,
    confidence: 0.3,
    stub: true,
  };

  // Deterministic slug => re-running this stage updates the same site row.
  // `status` is deliberately omitted so a re-run can never un-publish a site.
  const { data: site, error: siteErr } = await db
    .from("sites")
    .upsert(
      {
        slug: `upload-${asset.id}`,
        name_en: name,
        category: extracted.category,
        summary_en: summary,
        tags: extracted.tags,
        origin: "upload",
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (siteErr || !site) {
    throw new Error(
      `Could not create draft site: ${siteErr?.message ?? "no row returned"}`,
    );
  }
  const siteId = (site as { id: string }).id;

  const { error: assetErr } = await db
    .from("assets")
    .update({
      extracted,
      extract_provider: "stub",
      extract_model: "stub",
      site_id: siteId,
    })
    .eq("id", asset.id);
  if (assetErr)
    throw new Error(`Could not save extraction: ${assetErr.message}`);

  const { error: jobErr } = await db
    .from("jobs")
    .update({ site_id: siteId })
    .eq("id", job.id);
  if (jobErr) throw new Error(`Could not link job to site: ${jobErr.message}`);

  return { output: { siteId, extracted }, provider: "stub", model: "stub" };
};
