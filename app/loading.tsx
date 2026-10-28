export default function RootLoading() {
  return (
    <div
      role="status"
      aria-label="Loading page content"
      className="flex min-h-screen flex-col items-center justify-center bg-stone-50 text-stone-900"
    >
      <div className="flex flex-col items-center">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute h-full w-full animate-ping rounded-full bg-amber-400 opacity-20" />
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-amber-800 border-t-transparent" />
          <span className="text-xs font-bold text-amber-900">DH</span>
        </div>
        <h2 className="mt-4 font-serif text-lg font-semibold tracking-wide text-stone-800">
          Dharohar
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Loading cultural archives &amp; map data...
        </p>
      </div>
    </div>
  );
}
