import { describe, it, expect } from "vitest";
import {
  hasBeenSkimmed,
  draftFromProfile,
  draftFromVoice,
  parseSavePayload,
  savePayloadToPatch,
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
