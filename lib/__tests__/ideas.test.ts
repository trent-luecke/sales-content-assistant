import { describe, it, expect } from "vitest";
import { dedupeIdeas, rankIdeas, classifyClaim, type Idea } from "@/lib/ideas";

const mk = (hook: string, score = 0): Idea => ({
  rep_id: "r1", source: "demo", source_ref: {}, hook, rationale: "", score,
});

describe("dedupeIdeas", () => {
  it("drops incoming hooks that already exist (case/space-insensitive)", () => {
    const out = dedupeIdeas(["Go quiet in the demo"], [mk("go   QUIET in the demo"), mk("new angle")]);
    expect(out.map((i) => i.hook)).toEqual(["new angle"]);
  });
  it("drops duplicates within the incoming batch too", () => {
    const out = dedupeIdeas([], [mk("same hook"), mk("Same Hook"), mk("other")]);
    expect(out.map((i) => i.hook)).toEqual(["same hook", "other"]);
  });
});

describe("rankIdeas", () => {
  it("sorts by score descending without mutating input", () => {
    const input = [mk("a", 1), mk("b", 3), mk("c", 2)];
    const out = rankIdeas(input);
    expect(out.map((i) => i.hook)).toEqual(["b", "c", "a"]);
    expect(input.map((i) => i.hook)).toEqual(["a", "b", "c"]); // unmutated
  });
});

const anIdea = (over: Partial<Idea> = {}): Idea => ({
  id: "i1", rep_id: "r1", source: "demo", source_ref: {}, hook: "h", rationale: "", score: 0, ...over,
});

describe("classifyClaim", () => {
  it("claimed when the conditional update returned a row", () => {
    const claimed = anIdea({ status: "used" });
    expect(classifyClaim(claimed, null)).toEqual({ outcome: "claimed", idea: claimed });
  });
  it("already_used when nothing was claimed but the idea exists for the rep", () => {
    const existing = anIdea({ status: "used" });
    expect(classifyClaim(null, existing)).toEqual({ outcome: "already_used", idea: existing });
  });
  it("not_found when neither a claim nor an existing idea is present", () => {
    expect(classifyClaim(null, null)).toEqual({ outcome: "not_found" });
  });
});
