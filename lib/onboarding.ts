import { z } from "zod";
import type { Profile } from "@/lib/profiles";

export interface VoiceTraitInput {
  name: string;
  description: string;
  examples: string[];
}

export interface DraftProfile {
  displayName: string;
  traits: VoiceTraitInput[];
  background: string;
  angle: string;
  channels: string[];
  admiredPost: string;
}

// Single source of truth for field bounds. The save schema validates against
// these, and clampDraft trims skim/stored drafts to them — so a rep who accepts
// the AI draft unmodified can never trip a save-validation error on content the
// model produced (the skim schema doesn't cap output length; this does).
export const LIMITS = {
  displayName: 120,
  traitName: 120,
  traitDescription: 500,
  traitExample: 1000,
  examplesPerTrait: 10,
  traits: 12,
  background: 4000,
  angle: 4000,
  channel: 60,
  channels: 10,
  admiredPost: 8000,
} as const;

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

// Trim a draft to the save limits (no-op when already within bounds).
export function clampDraft(d: DraftProfile): DraftProfile {
  return {
    displayName: cut(d.displayName, LIMITS.displayName),
    traits: d.traits.slice(0, LIMITS.traits).map((t) => ({
      name: cut(t.name, LIMITS.traitName),
      description: cut(t.description, LIMITS.traitDescription),
      examples: t.examples
        .slice(0, LIMITS.examplesPerTrait)
        .map((e) => cut(e, LIMITS.traitExample)),
    })),
    background: cut(d.background, LIMITS.background),
    angle: cut(d.angle, LIMITS.angle),
    channels: d.channels.slice(0, LIMITS.channels).map((c) => cut(c, LIMITS.channel)),
    admiredPost: cut(d.admiredPost, LIMITS.admiredPost),
  };
}

// True once a skim (or a prior save) has populated the voice profile — the page
// then pre-fills from stored data instead of re-running the expensive skim.
export function hasBeenSkimmed(p: Profile): boolean {
  return Array.isArray(p.voice_traits) && p.voice_traits.length > 0;
}

export function draftFromProfile(p: Profile): DraftProfile {
  return clampDraft({
    displayName: p.display_name ?? "",
    traits: (p.voice_traits as VoiceTraitInput[]) ?? [],
    background: p.background ?? "",
    angle: p.angle ?? "",
    channels: (p.channels as string[]) ?? [],
    admiredPost: p.admired_post ?? "",
  });
}

export function draftFromVoice(
  p: Profile,
  voice: { traits: VoiceTraitInput[]; background: string; angle: string },
): DraftProfile {
  return clampDraft({
    displayName: p.display_name ?? "",
    traits: voice.traits,
    background: voice.background,
    angle: voice.angle,
    channels: [],
    admiredPost: "",
  });
}

const saveSchema = z.object({
  token: z.string().min(1),
  displayName: z.string().max(LIMITS.displayName).default(""),
  traits: z
    .array(
      z.object({
        name: z.string().max(LIMITS.traitName),
        description: z.string().max(LIMITS.traitDescription),
        examples: z.array(z.string().max(LIMITS.traitExample)).max(LIMITS.examplesPerTrait),
      }),
    )
    .max(LIMITS.traits),
  background: z.string().max(LIMITS.background).default(""),
  angle: z.string().max(LIMITS.angle).default(""),
  channels: z.array(z.string().max(LIMITS.channel)).max(LIMITS.channels).default([]),
  admiredPost: z.string().max(LIMITS.admiredPost).default(""),
});

export type SavePayload = z.infer<typeof saveSchema>;

export function parseSavePayload(
  raw: unknown,
): { ok: true; value: SavePayload } | { ok: false; error: string } {
  const r = saveSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const error = r.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

// Map the validated (camelCase) payload to a snake_case Profile patch.
// Empty strings become null so the DB holds NULL, not "".
export function savePayloadToPatch(v: SavePayload): Partial<Profile> {
  return {
    display_name: v.displayName || null,
    voice_traits: v.traits,
    background: v.background || null,
    angle: v.angle || null,
    channels: v.channels,
    admired_post: v.admiredPost || null,
  };
}
