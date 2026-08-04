import { describe, it, expect } from "vitest";
import {
  forbiddenNames,
  redact,
  buildDraftPrompt,
  type DemoMoment,
} from "@/lib/generation";
import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

const moment = (over: Partial<DemoMoment> = {}): DemoMoment => ({
  title: "Gretchen Collins and Chris Reynolds",
  repTurns: ["So here's how I'd run the demo…", "Beautiful."],
  speakers: ["Chris", "Gretchen Collins", "Trent"],
  repFirstName: "Trent",
  ...over,
});

const idea = (over: Partial<Idea> = {}): Idea => ({
  id: "idea-1",
  rep_id: "rep-1",
  source: "demo",
  source_ref: { meetingId: "m1" },
  hook: "The moment a demo lands is when I go quiet",
  rationale: "contrarian, teaches a method",
  score: 0,
  status: "candidate",
  ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: "rep-1",
  avoma_rep_name: "Trent Luecke",
  slack_user_id: "U04ECG6KEA3",
  magic_token: "tok",
  display_name: "Trent",
  voice_traits: [{ name: "Direct", description: "no fluff", examples: ["Beautiful."] }],
  background: "ex-coach",
  angle: "outsider who makes it approachable",
  channels: ["LinkedIn"],
  admired_post: "some admired post",
  status: "active",
  ...over,
});

describe("forbiddenNames", () => {
  it("unions title names and non-rep speakers, excluding the rep", () => {
    const names = forbiddenNames(moment());
    expect(names).toContain("Gretchen Collins");
    expect(names).toContain("Chris Reynolds");
    expect(names).toContain("Chris");
    // rep's own name is never forbidden
    expect(names).not.toContain("Trent");
  });
  it("excludes the rep even when a speaker label is the rep's full name", () => {
    const names = forbiddenNames(moment({ speakers: ["Trent Luecke", "Dana"] }));
    expect(names).not.toContain("Trent Luecke");
    expect(names).toContain("Dana");
  });
  it("dedupes case-insensitively", () => {
    const names = forbiddenNames(moment({ title: "Chris", speakers: ["chris", "CHRIS"] }));
    expect(names.filter((n) => n.toLowerCase() === "chris")).toHaveLength(1);
  });
  it("splits title names on commas without requiring leading whitespace", () => {
    const names = forbiddenNames(moment({ title: "Gretchen, Chris, and Dana" }));
    expect(names).toContain("Gretchen");
    expect(names).toContain("Chris");
    expect(names).toContain("Dana");
  });
  it("includes 2-character speaker names", () => {
    const names = forbiddenNames(moment({ title: "", speakers: ["Al"] }));
    expect(names).toContain("Al");
  });
});

describe("redact", () => {
  it("replaces a forbidden name with the neutral token", () => {
    expect(redact("Great chat with Gretchen today", ["Gretchen"])).toBe(
      "Great chat with [someone] today",
    );
  });
  it("is case-insensitive and leaves the possessive apostrophe attached", () => {
    expect(redact("gretchen's crew loved it", ["Gretchen"])).toBe("[someone]'s crew loved it");
  });
  it("does not touch a name embedded in another word", () => {
    expect(redact("Acmeplex shipped", ["Acme"])).toBe("Acmeplex shipped");
    expect(redact("Acme shipped", ["Acme"])).toBe("[someone] shipped");
  });
  it("leaves clean text untouched", () => {
    expect(redact("a strength coach I met", ["Gretchen", "Acme"])).toBe(
      "a strength coach I met",
    );
  });
  it("redacts longer names first so fragments are not exposed", () => {
    const result = redact("Chris Reynolds gave a great demo", ["Chris", "Chris Reynolds"]);
    expect(result).toBe("[someone] gave a great demo");
    expect(result).not.toMatch(/Reynolds/);
  });
});

describe("buildDraftPrompt", () => {
  it("includes voice traits, the hook, the rationale, and the anonymization rule", () => {
    const p = buildDraftPrompt(idea(), profile(), moment());
    expect(p).toContain("Direct");
    expect(p).toContain("The moment a demo lands is when I go quiet");
    expect(p).toContain("outsider who makes it approachable");
    expect(p.toLowerCase()).toContain("never name");
  });
  it("includes the demo moment's rep turns for demo ideas", () => {
    const p = buildDraftPrompt(idea(), profile(), moment());
    expect(p).toContain("So here's how I'd run the demo");
  });
  it("omits the moment section for organic ideas (moment null)", () => {
    const p = buildDraftPrompt(idea({ source: "organic", source_ref: {} }), profile(), null);
    expect(p).not.toContain("So here's how I'd run the demo");
    // still voice-conditioned and rule-bound
    expect(p).toContain("Direct");
    expect(p.toLowerCase()).toContain("never name");
  });
});
