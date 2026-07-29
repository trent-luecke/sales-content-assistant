import { describe, it, expect } from "vitest";
import { toIdeas } from "@/lib/mining";

describe("toIdeas", () => {
  it("maps raw AI items to Idea rows with rep_id and candidate defaults", () => {
    const out = toIdeas("rep-1", [
      { source: "demo", hook: "Go quiet in the demo", rationale: "contrarian", sourceRef: { meetingId: "m1" } },
      { source: "organic", hook: "Outsider angle", rationale: "fresh", sourceRef: {} },
    ]);
    expect(out).toEqual([
      { rep_id: "rep-1", source: "demo", hook: "Go quiet in the demo", rationale: "contrarian", source_ref: { meetingId: "m1" }, score: 0 },
      { rep_id: "rep-1", source: "organic", hook: "Outsider angle", rationale: "fresh", source_ref: {}, score: 0 },
    ]);
  });
  it("drops items with an empty hook", () => {
    expect(toIdeas("r", [{ source: "demo", hook: "  ", rationale: "x", sourceRef: {} }])).toEqual([]);
  });
});
