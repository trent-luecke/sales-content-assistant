import { describe, it, expect } from "vitest";
import { buildDigestBlocks, DRAFT_THIS_ACTION } from "@/lib/digest";
import type { Idea } from "@/lib/ideas";

const mk = (id: string, hook: string): Idea => ({
  id,
  rep_id: "rep-1",
  source: "demo",
  source_ref: {},
  hook,
  rationale: `why ${hook} lands`,
  score: 0,
  status: "candidate",
});

// Narrow helpers — Block Kit blocks are a big union; index by `type`.
const types = (blocks: { type: string }[]) => blocks.map((b) => b.type);
const buttons = (blocks: any[]) =>
  blocks.filter((b) => b.type === "actions").map((b) => b.elements[0]);

describe("buildDigestBlocks", () => {
  it("renders one idea: header + section + actions, no dividers", () => {
    const blocks = buildDigestBlocks([mk("id-1", "Go quiet in the demo")]);
    expect(types(blocks)).toEqual(["section", "section", "actions"]);
    // First section is the header; second carries the hook + rationale.
    const body = blocks[1] as any;
    expect(body.text.type).toBe("mrkdwn");
    expect(body.text.text).toContain("Go quiet in the demo");
    expect(body.text.text).toContain("why Go quiet in the demo lands");
  });

  it("puts a divider between ideas but never after the last", () => {
    const blocks = buildDigestBlocks([
      mk("id-1", "A"),
      mk("id-2", "B"),
      mk("id-3", "C"),
    ]);
    // header, (section,actions), divider, (section,actions), divider, (section,actions)
    expect(types(blocks)).toEqual([
      "section",
      "section", "actions",
      "divider",
      "section", "actions",
      "divider",
      "section", "actions",
    ]);
  });

  it("gives every button the draft_this action_id and the idea id as value", () => {
    const blocks = buildDigestBlocks([mk("id-1", "A"), mk("id-2", "B")]);
    const btns = buttons(blocks);
    expect(btns).toHaveLength(2);
    for (const b of btns) expect(b.action_id).toBe(DRAFT_THIS_ACTION);
    expect(btns.map((b) => b.value)).toEqual(["id-1", "id-2"]);
    expect(DRAFT_THIS_ACTION).toBe("draft_this");
  });

  it("returns only the header when there are no ideas", () => {
    // Defensive: assembleAndDeliver skips the empty case, but the shaper stays total.
    expect(types(buildDigestBlocks([]))).toEqual(["section"]);
  });
});
