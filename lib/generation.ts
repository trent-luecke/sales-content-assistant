import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { containsAny } from "@/lib/guardrail";

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

  // Whole labels: title names ∪ non-rep speaker labels, rep removed.
  const whole = [...splitTitleNames(moment.title), ...moment.speakers]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !isRep(s));

  // Also forbid each component token (first name / surname) so a casual bare
  // first name ("Chris" from "Chris Reynolds") is caught by the second-pass
  // check and the redactor — not only the full label. The rep's own first name
  // is never forbidden.
  const tokens = whole
    .flatMap((n) => n.split(/\s+/))
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.toLowerCase() !== rep);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...whole, ...tokens]) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

// Replace every forbidden name (case-insensitive, word-boundary) with a neutral
// token. Matches are found across the ORIGINAL text for all names first, then
// overlapping spans are merged and replaced in one pass — so overlapping names
// (e.g. "Ann Marie" + "Marie Curie") can't leave a fragment exposed. A trailing
// possessive apostrophe survives ("Gretchen's" -> "[someone]'s") because the
// boundary lookahead treats the apostrophe as a non-word char.
export function redact(text: string, names: string[]): string {
  const spans: [number, number][] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 1) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
    }
  }
  if (spans.length === 0) return text;

  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [spans[0]];
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    out += text.slice(pos, s) + "[someone]";
    pos = e;
  }
  out += text.slice(pos);
  return out;
}

export type Platform = "linkedin" | "instagram";

// Human-facing labels for the platform tokens. Shared by draft.ts (interim/partial
// messages) and digest.ts (retry buttons) so the mapping lives in one place.
export const PLATFORM_LABEL: Record<Platform, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
};

// Short platform tags for canvas titles (rep-facing shorthand).
export const PLATFORM_TAG: Record<Platform, string> = {
  linkedin: "LI",
  instagram: "IG",
};

// A canvas title tagged with the target platform, e.g. "LI: <hook>" / "IG: <hook>",
// capped at 60 chars (the tag is preserved; the hook is truncated with an ellipsis).
export function canvasTitle(platform: Platform, hook: string): string {
  const t = `${PLATFORM_TAG[platform]}: ${hook.trim()}`;
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

// A stable, platform-level canvas title. There is one reused canvas per platform, so this
// never needs to change — and Slack has no API to rename a canvas. e.g. "LinkedIn draft".
export function canvasName(platform: Platform): string {
  return `${PLATFORM_LABEL[platform]} draft`;
}

// The canvas document: the idea's hook as an H1 heading above the drafted body. Passed to
// both create and the full-document reuse-edit, so the heading always names the current
// idea even though the canvas title itself is fixed.
export function canvasDocument(hook: string, body: string): string {
  return `# ${hook}\n\n${body}`;
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
  platform: Platform,
): string {
  const parts: string[] = [];
  parts.push(
    "Write a single social post in this sales rep's own voice. First person, natural. " +
      "No hashtags. No emoji. The rep will add those by hand if they want. Return ONLY the post text.",
  );
  parts.push(
    "HARD RULE: never name a customer, prospect, company, club, or deal. Render every " +
      "story as an anonymized pattern (e.g. 'a strength coach I spoke with'). If you are " +
      "unsure whether something identifies a real party, generalize it.",
  );
  if (platform === "linkedin") {
    parts.push(
      "## Platform: LinkedIn\nAim for ~120-250 words. Open with a strong first line, then an " +
        "anonymized insight, then a takeaway.",
    );
  } else {
    parts.push(
      "## Platform: Instagram\nKeep it tight (~40-110 words). Put the payload in the FIRST line " +
        "(Instagram truncates ~125 characters). Hook, one or two beats, a light close. Leave " +
        "whitespace between short lines.\n\nAfter the caption, output a line containing exactly " +
        "===VISUAL=== on its own, then 1-2 concrete, anonymized ideas for a visual asset the rep " +
        "could take to an image generator. Never name a real person, company, or client in the " +
        "visual ideas either.",
    );
  }
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

const VISUAL_SENTINEL = "===VISUAL===";

// Split raw Instagram model output into caption + visual on the FIRST sentinel.
// No sentinel -> the whole text is the caption and visual is null.
export function splitVisual(raw: string): { caption: string; visual: string | null } {
  const i = raw.indexOf(VISUAL_SENTINEL);
  if (i === -1) return { caption: raw.trim(), visual: null };
  const caption = raw.slice(0, i).trim();
  const visual = raw.slice(i + VISUAL_SENTINEL.length).trim();
  return { caption, visual: visual.length > 0 ? visual : null };
}

// Turn raw (already-anonymized) model output into canvas-ready markdown.
// LinkedIn: unchanged. Instagram: caption + a labeled visual section when present.
export function assembleCanvasBody(raw: string, platform: Platform): string {
  if (platform === "linkedin") return raw;
  const { caption, visual } = splitVisual(raw);
  if (!visual) return caption;
  return `${caption}\n\n---\n\n**Visual idea — not part of your caption**\n\n${visual}`;
}

const MODEL = anthropic("claude-sonnet-5");

// Generate a first-draft post in the rep's voice with the anonymization guardrail
// enforced: model call -> second-pass name check -> regenerate once if a name
// leaked -> redact as a last resort. For organic ideas (moment null) the forbidden
// list is empty and the checks are no-ops (inputs are already anonymized).
export async function generateDraft(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
  platform: Platform,
): Promise<{ body: string; wasRedacted: boolean }> {
  const forbidden = moment ? forbiddenNames(moment) : [];
  const basePrompt = buildDraftPrompt(idea, profile, moment, platform);

  let { text } = await generateText({ model: MODEL, prompt: basePrompt });
  let leaked = containsAny(text, forbidden);

  if (leaked) {
    const retryPrompt =
      basePrompt +
      `\n\nA prior draft included the name "${leaked}". Do NOT mention "${leaked}" or any ` +
      `other real person, company, or client. Rewrite the post fully anonymized.`;
    ({ text } = await generateText({ model: MODEL, prompt: retryPrompt }));
    leaked = containsAny(text, forbidden);
  }

  let wasRedacted = false;
  if (leaked) {
    text = redact(text, forbidden);
    wasRedacted = true;
  }

  return { body: assembleCanvasBody(text, platform), wasRedacted };
}
