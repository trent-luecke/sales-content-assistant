import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Clients are stateless w.r.t. reps; memoizing at module scope is safe and
// avoids rebuilding on warm invocations.
let _sca: SupabaseClient | null = null;
let _rag: SupabaseClient | null = null;

export function scaClient(): SupabaseClient {
  if (!_sca) {
    _sca = createClient(
      process.env.SCA_SUPABASE_URL!,
      process.env.SCA_SUPABASE_SERVICE_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return _sca;
}

export function ragReadClient(): SupabaseClient {
  if (!_rag) {
    _rag = createClient(
      process.env.RAG_SUPABASE_URL!,
      process.env.RAG_SUPABASE_READONLY_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return _rag;
}
