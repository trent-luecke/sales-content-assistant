import { describe, it, expect } from "vitest";
import { dedupeIdeas, rankIdeas, type Idea } from "@/lib/ideas";

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
