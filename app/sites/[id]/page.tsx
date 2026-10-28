import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import SiteGallery from "@/components/SiteGallery";
import SiteMapSnippet from "@/components/SiteMapSnippet";
import { categoryLabel } from "@/lib/facets";
import {
  getSiteDetail,
  type RelatedSite,
  type SiteInfo,
  type SourceDoc,
} from "@/lib/site-detail";

// Cache Components is on: reading `params` and the database are request-time work, so they
// live in <SiteContent>, under Suspense. The shell (back link, skeleton) prerenders.
export default function SitePage(props: PageProps<"/sites/[id]">) {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-5 sm:px-6">
        <Suspense fallback={<PageSkeleton />}>
          <SiteContent params={props.params} />
        </Suspense>
      </div>
    </div>
  );
}

async function SiteContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getSiteDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const { site, photos, documents, related } = detail;

  return (
    <article>
      <title>{`${site.name_en} · Dharohar`}</title>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href={`/?site=${site.id}`}
          className="font-medium text-amber-800 underline-offset-2 hover:underline"
        >
          ← Back to the map
        </Link>
      </nav>

      <Header site={site} />

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-10">
          {photos.length > 0 ? (
            <SiteGallery images={photos} name={site.name_en} />
          ) : (
            <NoPhotos />
          )}

          {site.summary_en && (
            <Section title="About this record">
              <p className="max-w-[68ch] text-[15px] leading-relaxed text-stone-800">
                {site.summary_en}
              </p>
              {site.folklore_notes && (
                <aside className="mt-4 max-w-[68ch] rounded-lg border-l-4 border-amber-600 bg-amber-50 px-4 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                    Folklore &amp; oral tradition
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-stone-800">
                    {site.folklore_notes}
                  </p>
                </aside>
              )}
            </Section>
          )}

          <SourceTexts documents={documents} />
        </div>

        <aside className="min-w-0 space-y-8 lg:sticky lg:top-5 lg:self-start">
          <Section title="Location">
            {site.lat != null && site.lng != null ? (
              <SiteMapSnippet
                id={site.id}
                name={site.name_en}
                lat={site.lat}
                lng={site.lng}
              />
            ) : (
              <p className="rounded-lg bg-stone-100 p-4 text-sm text-stone-600">
                This record has no map location yet.
              </p>
            )}
            <LocationProvenance site={site} />
          </Section>

          <Section title="Extracted details">
            <Metadata site={site} />
          </Section>
        </aside>
      </div>

      <Related related={related} />
    </article>
  );
}

/* ---------------------------------------------------------------- header */

function Header({ site }: { site: SiteInfo }) {
  const place = [site.district, site.state].filter(Boolean).join(", ");
  return (
    <header>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-amber-700 px-2.5 py-1 font-semibold uppercase tracking-wide text-white">
          {categoryLabel(site.category)}
        </span>
        {site.period && (
          <span className="rounded-full bg-white px-2.5 py-1 text-stone-700 ring-1 ring-stone-300">
            {site.period}
          </span>
        )}
        {place && <span className="text-stone-600">{place}</span>}
      </div>
      <h1 className="mt-3 font-serif text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
        {site.name_en}
      </h1>
      {site.name_local && (
        <p className="mt-1 text-xl text-stone-600" translate="no">
          {site.name_local}
        </p>
      )}
    </header>
  );
}

function NoPhotos() {
  return (
    <div className="flex aspect-[16/7] flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white text-center">
      <p className="text-sm font-medium text-stone-700">No photographs yet</p>
      <Link
        href="/upload"
        className="mt-1 text-sm text-amber-800 underline underline-offset-2"
      >
        Contribute one
      </Link>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 font-serif text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------- source texts */

function languageName(code: string | null): string | null {
  if (!code) return null;
  if (/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(code)) {
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  }
  return code; // already a name, e.g. "Hindi"
}

function langAttr(code: string | null): string | undefined {
  return code && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(code) ? code : undefined;
}

function SourceTexts({ documents }: { documents: SourceDoc[] }) {
  const withText = documents.filter((d) => d.ocrText || d.textEn);
  if (withText.length === 0) {
    return (
      <Section title="Source text">
        <p className="rounded-lg bg-white p-4 text-sm text-stone-600 ring-1 ring-stone-200">
          No source documents have been attached to this record.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Source text &amp; translation">
      <div className="space-y-6">
        {withText.map((d, i) => (
          <SourceCard key={d.id} doc={d} index={i + 1} total={withText.length} />
        ))}
      </div>
    </Section>
  );
}

function SourceCard({
  doc,
  index,
  total,
}: {
  doc: SourceDoc;
  index: number;
  total: number;
}) {
  const lang = languageName(doc.language);
  const sameText = doc.ocrText && doc.textEn && doc.ocrText === doc.textEn;
  // English-language sources have no separate translation: show one column.
  const single = !doc.ocrText || !doc.textEn || sameText;
  return (
    <div className="overflow-hidden rounded-xl bg-white ring-1 ring-stone-200">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 bg-stone-50 px-4 py-2 text-xs text-stone-600">
        <span className="font-semibold text-stone-800">
          {doc.kind === "scan" ? "Scanned document" : "Photographed text"}
          {total > 1 ? ` ${index} of ${total}` : ""}
        </span>
        {lang && <span>Language: {lang}</span>}
        {doc.ocrConfidence != null && (
          <span title="How confident the text recognition was">
            OCR confidence {Math.round(doc.ocrConfidence * 100)}%
          </span>
        )}
        {doc.fileUrl && (
          <a
            href={doc.fileUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto font-medium text-amber-800 underline-offset-2 hover:underline"
          >
            {doc.isPdf ? "Open PDF ↗" : "View original ↗"}
          </a>
        )}
      </div>

      {!doc.ocrText && !doc.textEn ? null : (
        <div className={single ? "" : "grid divide-stone-200 md:grid-cols-2 md:divide-x"}>
          {!single && (
            <TextPane
              label={lang ? `Original (${lang})` : "Original"}
              lang={langAttr(doc.language)}
              text={doc.ocrText!}
              large
            />
          )}
          <TextPane
            label={single && doc.ocrText && !doc.textEn ? "Original text" : "English"}
            lang={single && doc.ocrText && !doc.textEn ? langAttr(doc.language) : "en"}
            text={(single ? (doc.textEn ?? doc.ocrText) : doc.textEn)!}
            note={
              !single
                ? "Machine translation; may contain errors."
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

function TextPane({
  label,
  text,
  lang,
  large,
  note,
}: {
  label: string;
  text: string;
  lang?: string;
  large?: boolean;
  note?: string;
}) {
  return (
    <div className="min-w-0 p-4 max-md:border-t max-md:border-stone-200 max-md:first:border-t-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
        {label}
      </h3>
      <div
        lang={lang}
        tabIndex={0}
        role="region"
        aria-label={label}
        className={`mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-stone-900 focus-visible:outline-2 focus-visible:outline-amber-700 ${
          large ? "text-[17px]" : "text-[15px]"
        }`}
      >
        {text}
      </div>
      {note && <p className="mt-2 text-xs text-stone-500">{note}</p>}
    </div>
  );
}

/* -------------------------------------------------------------- metadata */

const LOCATION_SOURCE: Record<string, string> = {
  exif: "Read from the photo's GPS data",
  geocoded: "Looked up from the place name",
  manual: "Placed by hand",
  seed: "Curated",
};

function LocationProvenance({ site }: { site: SiteInfo }) {
  if (site.lat == null) return null;
  const src = site.location_source
    ? (LOCATION_SOURCE[site.location_source] ?? site.location_source)
    : null;
  if (!src) return null;
  return (
    <p className="mt-1 text-xs text-stone-500">
      {src}
      {site.location_confidence != null
        ? ` · ${Math.round(site.location_confidence * 100)}% confidence`
        : ""}
      {site.location_source === "geocoded" || site.location_source === "seed"
        ? ". Approximate."
        : ""}
    </p>
  );
}

function Confidence({
  field,
  site,
}: {
  field: string;
  site: SiteInfo;
}) {
  if (site.uncertain_fields.includes(field)) {
    return (
      <span
        title="Extracted with low confidence. Verify against the source."
        className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-amber-300"
      >
        Needs review
      </span>
    );
  }
  const c = site.field_confidence?.[field];
  if (typeof c !== "number" || c <= 0) return null;
  return (
    <span
      title="Extraction confidence"
      className="text-[11px] tabular-nums text-stone-400"
    >
      {Math.round(c * 100)}%
    </span>
  );
}

function Metadata({ site }: { site: SiteInfo }) {
  const rows: { label: string; field: string; value: React.ReactNode }[] = [
    { label: "Type", field: "type", value: categoryLabel(site.category) },
    { label: "Era", field: "era", value: site.period },
    {
      label: "Crafts",
      field: "crafts",
      value:
        site.crafts.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {site.crafts.map((c) => (
              <span
                key={c}
                className="rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-stone-300"
              >
                {c}
              </span>
            ))}
          </span>
        ) : null,
    },
    { label: "Place", field: "place_name", value: site.address_text },
    { label: "Region", field: "region", value: site.region },
    { label: "District", field: "district", value: site.district },
    { label: "State", field: "state", value: site.state },
    {
      label: "Local name",
      field: "name_local",
      value: site.name_local && <span translate="no">{site.name_local}</span>,
    },
  ];

  return (
    <div>
      <dl className="divide-y divide-stone-200 rounded-xl bg-white ring-1 ring-stone-200">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 text-sm"
          >
            <dt className="text-xs font-medium text-stone-500">{r.label}</dt>
            <dd className="min-w-0 break-words text-stone-900">
              {r.value || <span className="text-stone-400">Not stated</span>}
            </dd>
            <span>
              <Confidence field={r.field} site={site} />
            </span>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-stone-500">
        {site.origin === "seed"
          ? "Curated record."
          : site.extraction_confidence != null
            ? `Extracted automatically from an upload · overall confidence ${Math.round(site.extraction_confidence * 100)}%.`
            : "Extracted automatically from an upload."}
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- related */

function Related({ related }: { related: RelatedSite[] }) {
  if (related.length === 0) return null;
  const byEmbedding = related[0].basis === "embedding";
  return (
    <section className="mt-14">
      <h2 className="font-serif text-xl font-semibold">Related sites</h2>
      <p className="mb-4 mt-1 text-sm text-stone-600">
        {byEmbedding
          ? "Records whose text is closest in meaning to this one."
          : "Matched by type, region and tags. Meaning-based matches appear once embeddings are generated."}
      </p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {related.map((r) => (
          <li key={r.id}>
            <Link
              href={`/sites/${r.id}`}
              className="group flex h-full gap-3 rounded-xl bg-white p-3 ring-1 ring-stone-200 transition hover:ring-amber-600 focus-visible:outline-2 focus-visible:outline-amber-700"
            >
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-stone-100">
                {r.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, unknown host
                  <img
                    src={r.thumbnail}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-stone-400">
                    No photo
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold group-hover:text-amber-900">
                  {r.name}
                </div>
                <div className="truncate text-xs text-stone-500">
                  {[categoryLabel(r.type), r.district, r.state]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {r.era && (
                  <div className="truncate text-xs text-stone-500">{r.era}</div>
                )}
                {r.basis === "embedding" && (
                  <span
                    title="Cosine similarity between record embeddings"
                    className="mt-1.5 inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-900 ring-1 ring-indigo-200"
                  >
                    ≈ {Math.round(r.similarity * 100)}% similar
                  </span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- skeleton */

function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading site" className="animate-pulse">
      <div className="mb-4 h-4 w-32 rounded bg-stone-200" />
      <div className="h-5 w-40 rounded bg-stone-200" />
      <div className="mt-3 h-9 w-2/3 rounded bg-stone-200" />
      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <div className="aspect-[4/3] rounded-xl bg-stone-200" />
          <div className="h-4 w-full rounded bg-stone-200" />
          <div className="h-4 w-5/6 rounded bg-stone-200" />
        </div>
        <div className="space-y-6">
          <div className="h-56 rounded-xl bg-stone-200" />
          <div className="h-64 rounded-xl bg-stone-200" />
        </div>
      </div>
    </div>
  );
}
