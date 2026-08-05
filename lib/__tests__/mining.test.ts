import { describe, it, expect } from "vitest";
import {
  toIdeas,
  filterUnminedDemos,
  isRepSpeaker,
  rawIdeasFromMined,
  type DemoTranscript,
} from "@/lib/mining";

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

describe("rawIdeasFromMined", () => {
  const demos: DemoTranscript[] = [
    { meetingId: "uuid-A", title: "A", date: "", repTurns: [] },
    { meetingId: "uuid-B", title: "B", date: "", repTurns: [] },
  ];

  it("maps a demo idea's demoNumber back to the real meetingId (1-based)", () => {
    const out = rawIdeasFromMined(
      [{ source: "demo", hook: "h", rationale: "r", demoNumber: 2 }],
      demos,
    );
    expect(out).toEqual([{ source: "demo", hook: "h", rationale: "r", sourceRef: { meetingId: "uuid-B" } }]);
  });

  it("gives organic ideas an empty sourceRef regardless of demoNumber", () => {
    const out = rawIdeasFromMined(
      [{ source: "organic", hook: "h", rationale: "r", demoNumber: 1 }],
      demos,
    );
    expect(out[0].sourceRef).toEqual({});
  });

  it("uses an empty sourceRef when demoNumber is missing or out of range (never trusts a fabricated id)", () => {
    const out = rawIdeasFromMined(
      [
        { source: "demo", hook: "no-num", rationale: "r" },
        { source: "demo", hook: "oob", rationale: "r", demoNumber: 99 },
      ],
      demos,
    );
    expect(out.map((r) => r.sourceRef)).toEqual([{}, {}]);
  });
});

describe("isRepSpeaker", () => {
  it("matches the rep by exact first-name token", () => {
    expect(isRepSpeaker("Trent Luecke", "trent")).toBe(true);
    expect(isRepSpeaker("Trent", "trent")).toBe(true);
  });
  it("does NOT match a customer whose name merely contains the rep's first name", () => {
    expect(isRepSpeaker("Christina Vale", "chris")).toBe(false); // the leak-risk case
    expect(isRepSpeaker("Sal", "al")).toBe(false);
  });
  it("never matches when the rep first name is empty", () => {
    expect(isRepSpeaker("Anyone", "")).toBe(false);
  });
});
