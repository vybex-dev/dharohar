import Link from "next/link";

export default function SiteNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-stone-50 px-6 text-center text-stone-900">
      <h1 className="font-serif text-3xl font-semibold">Site not found</h1>
      <p className="mt-2 max-w-sm text-sm text-stone-600">
        This record doesn’t exist, or it hasn’t been published yet.
      </p>
      <Link
        href="/"
        className="mt-6 rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
      >
        Back to the map
      </Link>
    </div>
  );
}
