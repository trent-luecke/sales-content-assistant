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

// True once a skim (or a prior save) has populated the voice profile — the page
// then pre-fills from stored data instead of re-running the expensive skim.
export function hasBeenSkimmed(p: Profile): boolean {
  return Array.isArray(p.voice_traits) && p.voice_traits.length > 0;
}

export function draftFromProfile(p: Profile): DraftProfile {
  return {
    displayName: p.display_name ?? "",
    traits: (p.voice_traits as VoiceTraitInput[]) ?? [],
    background: p.background ?? "",
    angle: p.angle ?? "",
    channels: (p.channels as string[]) ?? [],
    admiredPost: p.admired_post ?? "",
  };
}

export function draftFromVoice(
  p: Profile,
  voice: { traits: VoiceTraitInput[]; background: string; angle: string },
): DraftProfile {
  return {
    displayName: p.display_name ?? "",
    traits: voice.traits,
    background: voice.background,
    angle: voice.angle,
    channels: [],
    admiredPost: "",
  };
}

const saveSchema = z.object({
  token: z.string().min(1),
  displayName: z.string().max(120).default(""),
  traits: z
    .array(
      z.object({
        name: z.string().max(120),
        description: z.string().max(500),
        examples: z.array(z.string().max(1000)).max(10),
      }),
    )
    .max(12),
  background: z.string().max(4000).default(""),
  angle: z.string().max(4000).default(""),
  channels: z.array(z.string().max(60)).max(10).default([]),
  admiredPost: z.string().max(8000).default(""),
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
