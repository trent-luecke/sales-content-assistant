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
