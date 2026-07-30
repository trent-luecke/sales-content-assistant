import { describe, it, expect } from "vitest";
import {
  hasBeenSkimmed,
  draftFromProfile,
  draftFromVoice,
  clampDraft,
  parseSavePayload,
  savePayloadToPatch,
  LIMITS,
} from "@/lib/onboarding";
import type { Profile } from "@/lib/profiles";

const baseProfile = (over: Partial<Profile> = {}): Profile => ({
  id: "rep-1",
  avoma_rep_name: "Trent Luecke",
  slack_user_id: "U04ECG6KEA3",
  magic_token: "tok",
  display_name: null,
  voice_traits: [],
  background: null,
  angle: null,
  channels: [],
  admired_post: null,
  status: "draft",
  ...over,
});

describe("hasBeenSkimmed", () => {
  it("is false when voice_traits is empty", () => {
    expect(hasBeenSkimmed(baseProfile())).toBe(false);
  });
  it("is true once voice_traits has entries", () => {
    expect(hasBeenSkimmed(baseProfile({ voice_traits: [{ name: "x", description: "", examples: [] }] }))).toBe(true);
  });
});

describe("draftFromProfile", () => {
  it("maps stored snake_case fields to the camelCase draft, nulls to empty strings", () => {
    const d = draftFromProfile(baseProfile({
      display_name: "Trent",
      voice_traits: [{ name: "Direct", description: "no fluff", examples: ["ex1"] }],
      background: "ex-coach",
      angle: "outsider",
      channels: ["LinkedIn"],
      admired_post: "some post",
    }));
    expect(d).toEqual({
      displayName: "Trent",
      traits: [{ name: "Direct", description: "no fluff", examples: ["ex1"] }],
      background: "ex-coach",
      angle: "outsider",
      channels: ["LinkedIn"],
      admiredPost: "some post",
    });
  });
});

describe("draftFromVoice", () => {
  it("uses derived voice + the profile's display name, with empty channels/admiredPost", () => {
    const d = draftFromVoice(baseProfile({ display_name: "Trent" }), {
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "guessed bg",
      angle: "guessed angle",
    });
    expect(d).toEqual({
      displayName: "Trent",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "guessed bg",
      angle: "guessed angle",
      channels: [],
      admiredPost: "",
    });
  });
});

describe("clampDraft", () => {
  it("clamps oversized fields to the save limits", () => {
    const clamped = clampDraft({
      displayName: "n".repeat(LIMITS.displayName + 50),
      traits: [
        {
          name: "t".repeat(LIMITS.traitName + 50),
          description: "d".repeat(LIMITS.traitDescription + 200),
          examples: Array.from({ length: LIMITS.examplesPerTrait + 5 }, () => "x".repeat(LIMITS.traitExample + 100)),
        },
      ],
      background: "b".repeat(LIMITS.background + 500),
      angle: "a".repeat(LIMITS.angle + 500),
      channels: ["LinkedIn"],
      admiredPost: "",
    });
    expect(clamped.displayName.length).toBe(LIMITS.displayName);
    expect(clamped.traits[0].name.length).toBe(LIMITS.traitName);
    expect(clamped.traits[0].description.length).toBe(LIMITS.traitDescription);
    expect(clamped.traits[0].examples.length).toBe(LIMITS.examplesPerTrait);
    expect(clamped.traits[0].examples[0].length).toBe(LIMITS.traitExample);
    expect(clamped.background.length).toBe(LIMITS.background);
    expect(clamped.angle.length).toBe(LIMITS.angle);
  });

  it("leaves an in-bounds draft untouched", () => {
    const d = {
      displayName: "Trent",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: "angle",
      channels: ["LinkedIn"],
      admiredPost: "post",
    };
    expect(clampDraft(d)).toEqual(d);
  });
});

describe("draftFromVoice + save round-trip (M1)", () => {
  it("produces a draft that always passes parseSavePayload, even from oversized voice", () => {
    const oversized = draftFromVoice(baseProfile({ display_name: "Trent" }), {
      traits: [
        {
          name: "Verbose",
          description: "d".repeat(LIMITS.traitDescription + 300),
          examples: Array.from({ length: LIMITS.examplesPerTrait + 8 }, (_, i) => `line ${i}`),
        },
      ],
      background: "b".repeat(LIMITS.background + 1000),
      angle: "a".repeat(LIMITS.angle + 1000),
    });
    // The exact shape the form POSTs to /api/onboard/save on an unmodified accept.
    const r = parseSavePayload({ token: "tok", ...oversized });
    expect(r.ok).toBe(true);
  });
});

describe("parseSavePayload", () => {
  it("accepts a well-formed payload", () => {
    const r = parseSavePayload({
      token: "tok",
      displayName: "Trent",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: "angle",
      channels: ["LinkedIn"],
      admiredPost: "post",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a missing token with an error string", () => {
    const r = parseSavePayload({ traits: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/token/);
  });
  it("defaults optional fields so a minimal payload is valid", () => {
    const r = parseSavePayload({ token: "tok", traits: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.displayName).toBe("");
      expect(r.value.channels).toEqual([]);
    }
  });
});

describe("savePayloadToPatch", () => {
  it("maps camelCase payload to a snake_case Profile patch, empty strings to null", () => {
    const patch = savePayloadToPatch({
      token: "tok",
      displayName: "",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: "",
      channels: ["LinkedIn"],
      admiredPost: "",
    });
    expect(patch).toEqual({
      display_name: null,
      voice_traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: null,
      channels: ["LinkedIn"],
      admired_post: null,
    });
  });
});
