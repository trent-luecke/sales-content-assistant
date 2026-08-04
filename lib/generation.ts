import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

export interface DemoMoment {
  title: string;
  repTurns: string[];
  speakers: string[];
  repFirstName: string;
}

interface VoiceTraitish {
  name?: string;
  description?: string;
  examples?: string[];
}

// Split a demo title into candidate names. Titles look like
// "Gretchen Collins and Chris Reynolds" or "Bre / Trent".
function splitTitleNames(title: string): string[] {
  return title
    .split(/\s*(?:[,&/|]|\band\b|\bwith\b|\bx\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The names that must never appear in rep-facing copy: title names ∪ the
// distinct non-rep speaker labels in the transcript (the actual people in the
// room), with the rep's own name removed. Deduped case-insensitively.
export function forbiddenNames(moment: DemoMoment): string[] {
  const rep = moment.repFirstName.trim().toLowerCase();
  const isRep = (n: string) => {
    const l = n.toLowerCase();
    return l === rep || (rep.length > 0 && l.startsWith(rep + " "));
  };
  const candidates = [...splitTitleNames(moment.title), ...moment.speakers]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !isRep(s));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of candidates) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

// Replace each forbidden name (case-insensitive, word-boundary) with a neutral
// token. A trailing possessive apostrophe survives ("Gretchen's" -> "[someone]'s")
// because the boundary lookahead treats the apostrophe as a non-word char.
export function redact(text: string, names: string[]): string {
  let out = text;
  // Longest names first, so a full name is consumed before any of its shorter
  // components can partially match and leave a fragment exposed.
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const raw of sorted) {
    const name = raw.trim();
    if (name.length < 1) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "gi");
    out = out.replace(re, "[someone]");
  }
  return out;
}

function renderTraits(traits: unknown[]): string {
  const list = (traits as VoiceTraitish[]) ?? [];
  return list
    .map((t) => {
      const ex = (t.examples ?? []).map((e) => `    - "${e}"`).join("\n");
      return `- ${t.name ?? "trait"}: ${t.description ?? ""}${ex ? `\n${ex}` : ""}`;
    })
    .join("\n");
}

// Assemble the voice-conditioned drafting prompt. Pure string building — the
// model call lives in generateDraft.
export function buildDraftPrompt(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
): string {
  const parts: string[] = [];
  parts.push(
    "Write a single social post (LinkedIn/Instagram) in this sales rep's own voice. " +
      "First person, natural, no hashtags unless the rep's examples use them. Return ONLY the post text.",
  );
  parts.push(
    "HARD RULE: never name a customer, prospect, company, club, or deal. Render every " +
      "story as an anonymized pattern (e.g. 'a strength coach I spoke with'). If you are " +
      "unsure whether something identifies a real party, generalize it.",
  );
  parts.push(`## The rep's voice\n${renderTraits(profile.voice_traits)}`);
  if (profile.background) parts.push(`## Background\n${profile.background}`);
  if (profile.angle) parts.push(`## Their distinctive angle\n${profile.angle}`);
  if (profile.admired_post) parts.push(`## A post they admire (echo the style, not the content)\n${profile.admired_post}`);
  parts.push(`## What to say\nHook: ${idea.hook}\nWhy it lands: ${idea.rationale}`);
  if (moment) {
    parts.push(
      `## The moment (from a real demo — anonymize any names before writing)\n` +
        moment.repTurns.join("\n"),
    );
  }
  return parts.join("\n\n");
}
