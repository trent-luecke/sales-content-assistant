import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { ragReadClient } from "@/lib/supabase";
import { containsAny } from "@/lib/guardrail";
import type { Idea, IdeaSource } from "@/lib/ideas";

const MODEL = anthropic("claude-sonnet-5");

export interface DemoTranscript {
  meetingId: string;
  title: string;
  date: string;
  repTurns: string[];
}
export interface VoiceTrait { name: string; description: string; examples: string[] }
export interface RawIdea {
  source: IdeaSource;
  hook: string;
  rationale: string;
  sourceRef: Record<string, unknown>;
}

// Pure: keep only demos whose meetingId hasn't already produced ideas. A demo
// that yielded only organic ideas last time (no meetingId recorded) stays here
// and gets re-read — hook-level dedup drops any duplicate output downstream.
export function filterUnminedDemos(demos: DemoTranscript[], minedMeetingIds: string[]): DemoTranscript[] {
  const mined = new Set(minedMeetingIds);
  return demos.filter((d) => !mined.has(d.meetingId));
}

// Pure: shape raw AI items into Idea rows; drop empty hooks.
export function toIdeas(repId: string, raw: RawIdea[]): Idea[] {
  return raw
    .filter((r) => r.hook.trim().length > 0)
    .map((r) => ({
      rep_id: repId, source: r.source, hook: r.hook, rationale: r.rationale,
      source_ref: r.sourceRef, score: 0,
    }));
}

// Read a rep's demos from the RAG (read-only). Two queries: the rep's demo
// meetings, then those meetings' chunks (proven in Spike C to hold speaker+text).
// Keeps only the rep's own turns (their voice), ordered by chunk_index.
export async function readRepDemos(avomaRepName: string, limit = 8): Promise<DemoTranscript[]> {
  const rag = ragReadClient();
  const { data: meetings, error } = await rag
    .from("meetings")
    .select("id,title,date,rep_name")
    .ilike("rep_name", `*${avomaRepName}*`)   // '*' wildcard, NOT '%' (see RAG list_meetings fix)
    .ilike("call_type", "demo")
    .order("date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (meetings ?? []) as any[];
  if (rows.length === 0) return [];

  const ids = rows.map((m) => m.id);
  const { data: chunks, error: cErr } = await rag
    .from("chunks")
    .select("meeting_id,speaker,text,chunk_index")
    .in("meeting_id", ids)
    .order("chunk_index", { ascending: true });
  if (cErr) throw cErr;
  const allChunks = (chunks ?? []) as any[];

  return rows.map((m) => {
    const first = (m.rep_name ?? avomaRepName).split(/\s+/)[0]?.toLowerCase() ?? "";
    const repTurns = allChunks
      .filter((c) => c.meeting_id === m.id &&
        typeof c.speaker === "string" && c.speaker.toLowerCase().includes(first) &&
        typeof c.text === "string")
      .map((c) => c.text as string)
      .slice(0, 400);
    return { meetingId: m.id, title: m.title ?? "", date: m.date ?? "", repTurns };
  });
}

export async function deriveVoiceProfile(demos: DemoTranscript[]): Promise<{
  traits: VoiceTrait[]; background: string; angle: string;
}> {
  const corpus = demos.map((d) => d.repTurns.join("\n")).join("\n---\n").slice(0, 40_000);
  const { object } = await generateObject({
    model: MODEL,
    schema: z.object({
      traits: z.array(z.object({
        name: z.string(), description: z.string(), examples: z.array(z.string()),
      })).min(3).max(8),
      background: z.string(),
      angle: z.string(),
    }),
    prompt:
      "You are extracting a sales rep's authentic voice from how they actually talk in demos. " +
      "Return 3-8 named voice traits, each with a one-line description and 2-3 verbatim example lines " +
      "from the text. Also infer a short 'background' guess and an 'angle' (their distinctive POV). " +
      "Use only the rep's own words below:\n\n" + corpus,
  });
  return object;
}

export async function mineIdeas(
  repId: string, demos: DemoTranscript[], profile: { angle: string },
): Promise<Idea[]> {
  // Collect real names to forbid from rep-facing text (anonymization guardrail).
  const forbidden = demos.flatMap((d) => namesFromTitle(d.title));
  const corpus = demos
    .map((d) => `# ${d.title} (${d.date})\n${d.repTurns.join("\n")}`)
    .join("\n\n").slice(0, 40_000);

  const { object } = await generateObject({
    model: MODEL,
    schema: z.object({
      ideas: z.array(z.object({
        source: z.enum(["demo", "organic"]),
        hook: z.string(),
        rationale: z.string(),
        meetingId: z.string().optional(),
      })),
    }),
    prompt:
      "Mine LinkedIn/IG content ideas for this rep. Two kinds: 'demo' ideas drawn from a real " +
      "moment in the transcripts, and 'organic' ideas from their angle: " + profile.angle + ". " +
      "HARD RULE: never name a customer, prospect, company, or deal — render every story as an " +
      "anonymized pattern (e.g. 'a strength coach I spoke with'). Each idea: a one-line hook and a " +
      "one-line rationale (why it'd land). For demo ideas include the meetingId.\n\n" + corpus,
  });

  const raw: RawIdea[] = object.ideas.map((i) => ({
    source: i.source,
    hook: i.hook,
    rationale: i.rationale,
    sourceRef: i.meetingId ? { meetingId: i.meetingId } : {},
  }));

  // Guardrail: drop any idea whose rep-facing text leaked a forbidden name.
  const safe = raw.filter((r) => !containsAny(`${r.hook} ${r.rationale}`, forbidden));
  return toIdeas(repId, safe);
}

function namesFromTitle(title: string): string[] {
  // Titles look like "Gretchen Collins and Chris Reynolds" / "Bre / Trent".
  return title.split(/\s+(?:and|&|\/|,)\s+|\s*[/|]\s*/i)
    .map((s) => s.trim()).filter((s) => s.length > 2);
}
