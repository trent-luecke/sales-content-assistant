import { scaClient } from "@/lib/supabase";

export type IdeaSource = "demo" | "organic";
export type IdeaStatus = "candidate" | "used" | "rejected";

export interface Idea {
  id?: string;
  rep_id: string;
  source: IdeaSource;
  source_ref: Record<string, unknown>;
  hook: string;
  rationale: string;
  score: number;
  status?: IdeaStatus;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function dedupeIdeas(existingHooks: string[], incoming: Idea[]): Idea[] {
  const seen = new Set(existingHooks.map(norm));
  const out: Idea[] = [];
  for (const idea of incoming) {
    const k = norm(idea.hook);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(idea);
  }
  return out;
}

export function rankIdeas<T extends { score: number }>(ideas: T[]): T[] {
  return [...ideas].sort((a, b) => b.score - a.score);
}

export async function existingHooks(repId: string): Promise<string[]> {
  const { data, error } = await scaClient()
    .from("sca_ideas").select("hook").eq("rep_id", repId);
  if (error) throw error;
  return (data ?? []).map((r) => r.hook as string);
}

// The set of demo meetingIds this rep has already produced ideas from — read
// from source_ref. Lets refill skip demos it has already mined (no ledger table).
export async function minedMeetingIds(repId: string): Promise<string[]> {
  const { data, error } = await scaClient()
    .from("sca_ideas").select("source_ref").eq("rep_id", repId);
  if (error) throw error;
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const ref = (row as { source_ref?: Record<string, unknown> }).source_ref;
    const mid = ref?.meetingId;
    if (typeof mid === "string" && mid.length > 0) ids.add(mid);
  }
  return [...ids];
}

export async function insertIdeas(ideas: Idea[]): Promise<void> {
  if (ideas.length === 0) return;
  const { error } = await scaClient().from("sca_ideas").insert(
    ideas.map((i) => ({
      rep_id: i.rep_id, source: i.source, source_ref: i.source_ref,
      hook: i.hook, rationale: i.rationale, score: i.score, status: "candidate",
    })),
  );
  if (error) throw error;
}

export async function selectTopCandidates(repId: string, n: number): Promise<Idea[]> {
  const { data, error } = await scaClient()
    .from("sca_ideas").select("*")
    .eq("rep_id", repId).eq("status", "candidate")
    .order("score", { ascending: false }).limit(n);
  if (error) throw error;
  return (data ?? []) as Idea[];
}

export async function setIdeaStatus(ideaId: string, status: IdeaStatus): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === "used") patch.used_at = new Date().toISOString();
  const { error } = await scaClient().from("sca_ideas").update(patch).eq("id", ideaId);
  if (error) throw error;
}

export type ClaimResult =
  | { outcome: "claimed"; idea: Idea }
  | { outcome: "already_used"; idea: Idea }
  | { outcome: "not_found" };

// Pure: map the two reads (the conditional-claim result and a plain lookup) to
// an outcome. Kept separate from the DB calls so the branching is unit-tested.
export function classifyClaim(claimed: Idea | null, existing: Idea | null): ClaimResult {
  if (claimed) return { outcome: "claimed", idea: claimed };
  if (existing) return { outcome: "already_used", idea: existing };
  return { outcome: "not_found" };
}

// Atomically claim a candidate idea for drafting. The conditional UPDATE
// (status='candidate' guard) is the double-click race guard: only one caller can
// flip it to 'used'. On a miss, a scoped lookup distinguishes already-drafted
// from not-found/wrong-rep (the latter also enforces cross-rep isolation).
export async function claimIdea(ideaId: string, repId: string): Promise<ClaimResult> {
  const sca = scaClient();
  const { data: claimed, error } = await sca
    .from("sca_ideas")
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", ideaId)
    .eq("rep_id", repId)
    .eq("status", "candidate")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (claimed) return classifyClaim(claimed as Idea, null);

  const { data: existing, error: rErr } = await sca
    .from("sca_ideas")
    .select("*")
    .eq("id", ideaId)
    .eq("rep_id", repId)
    .maybeSingle();
  if (rErr) throw rErr;
  return classifyClaim(null, (existing as Idea) ?? null);
}

// Fetch a rep's idea by id WITHOUT changing its status. Used by the retry path,
// which re-drafts one platform of an already-`used` idea and must not re-claim.
export async function getIdea(ideaId: string, repId: string): Promise<Idea | null> {
  const { data, error } = await scaClient()
    .from("sca_ideas")
    .select("*")
    .eq("id", ideaId)
    .eq("rep_id", repId)
    .maybeSingle();
  if (error) throw error;
  return (data as Idea) ?? null;
}
