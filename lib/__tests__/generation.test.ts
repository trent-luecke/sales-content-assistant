import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  forbiddenNames,
  redact,
  buildDraftPrompt,
  generateDraft,
  type DemoMoment,
} from "@/lib/generation";
import { generateText } from "ai";
import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

// Mock the AI SDK so no network/secret is needed; each test scripts the outputs.
vi.mock("ai", () => ({ generateText: vi.fn() }));

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
  it("redacts fully when two multi-word names overlap on a shared word", () => {
    const out = redact("Ann Marie Curie visited today", ["Ann Marie", "Marie Curie"]);
    expect(out).toBe("[someone] visited today");
    expect(out).not.toMatch(/Ann|Marie|Curie/);
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

describe("generateDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the draft unchanged when the first pass is clean", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "a strength coach I met loved it" } as any);
    const res = await generateDraft(idea(), profile(), moment());
    expect(res).toEqual({ body: "a strength coach I met loved it", wasRedacted: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("regenerates once when a name leaks, and returns the clean retry", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Chris and I nailed the demo" } as any) // leaks "Chris"
      .mockResolvedValueOnce({ text: "a coach and I nailed the demo" } as any); // clean
    const res = await generateDraft(idea(), profile(), moment());
    expect(res.wasRedacted).toBe(false);
    expect(res.body).toBe("a coach and I nailed the demo");
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("redacts as a fail-safe when the retry still leaks", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Chris crushed it" } as any)
      .mockResolvedValueOnce({ text: "Chris still crushed it" } as any); // still leaks
    const res = await generateDraft(idea(), profile(), moment());
    expect(res.wasRedacted).toBe(true);
    expect(res.body).toBe("[someone] still crushed it");
    expect(res.body).not.toMatch(/Chris/);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("does not check names for organic ideas (empty forbidden list)", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Big Company energy today" } as any);
    const res = await generateDraft(idea({ source: "organic", source_ref: {} }), profile(), null);
    expect(res).toEqual({ body: "Big Company energy today", wasRedacted: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
