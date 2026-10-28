import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  // Keep native/WASM-heavy packages out of the bundle and load them from node_modules.
  serverExternalPackages: ["sharp", "tesseract.js"],

  // Make sure Tesseract's worker and WASM core files are shipped with the advance route on Vercel.
  outputFileTracingIncludes: {
    "/api/jobs/[id]/advance": [
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
    ],
  },
};

export default nextConfig;
