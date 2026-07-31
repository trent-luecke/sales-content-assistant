import { describe, it, expect } from "vitest";
import { toIdeas, filterUnminedDemos, type DemoTranscript } from "@/lib/mining";

describe("filterUnminedDemos", () => {
  const demo = (id: string): DemoTranscript => ({ meetingId: id, title: "", date: "", repTurns: [] });
  it("drops demos already mined, keeps the rest in order", () => {
    expect(filterUnminedDemos([demo("m1"), demo("m2"), demo("m3")], ["m2"]).map((d) => d.meetingId))
      .toEqual(["m1", "m3"]);
  });
  it("returns all demos when nothing has been mined yet", () => {
    expect(filterUnminedDemos([demo("m1")], []).map((d) => d.meetingId)).toEqual(["m1"]);
  });
});

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
