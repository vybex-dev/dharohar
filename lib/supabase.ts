import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

/**
 * Browser-safe Supabase client. Uses only the public URL and anon key.
 * Row Level Security must protect anything this client can reach.
 * NEXT_PUBLIC_* vars must be referenced literally so Next can inline them.
 */
export function getBrowserSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Check .env.local (local) or Vercel project env vars (deployed).",
    );
  }

  browserClient = createClient(url, anonKey);
  return browserClient;
}
