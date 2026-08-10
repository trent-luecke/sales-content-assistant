import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDigestBlocks,
  DRAFT_THIS_ACTION,
  assembleAndDeliver,
  DRAFT_PLATFORM_ACTION,
  encodePlatformValue,
  parsePlatformValue,
  platformsForSelection,
  buildPlatformChoiceBlocks,
  DRAFT_RETRY_ACTION,
  buildRetryBlocks,
  buildOpenerBlocks,
  buildDoneConfirmBlocks,
  DRAFT_DONE_ACTION,
  DRAFT_DONE_CONFIRM_ACTION,
  DRAFT_DONE_CANCEL_ACTION,
} from "@/lib/digest";
import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

vi.mock("@/lib/ideas", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ideas")>("@/lib/ideas");
  return { ...actual, selectTopCandidates: vi.fn() };
});
vi.mock("@/lib/slack/client", () => ({
  slack: {
    conversations: { open: vi.fn() },
    chat: { postMessage: vi.fn() },
  },
}));
vi.mock("@/lib/supabase", () => ({
  scaClient: vi.fn(),
}));

import { selectTopCandidates } from "@/lib/ideas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";

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

  it("throws when an idea is missing its id", () => {
    const noId = { ...mk("x", "hook"), id: undefined } as Idea;
    expect(() => buildDigestBlocks([noId])).toThrow(/missing an id/);
  });
});

const profile = {
  id: "rep-1",
  avoma_rep_name: "Test Rep",
  slack_user_id: "U123",
  magic_token: "tok",
  display_name: null,
  voice_traits: [],
  background: null,
  angle: null,
  channels: [],
  admired_post: null,
  status: "active",
} as Profile;

const MOCK_TS = "1700000000.000100";

describe("assembleAndDeliver", () => {
  let insertMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    insertMock = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(scaClient).mockReturnValue({
      from: vi.fn().mockReturnValue({ insert: insertMock }),
    } as unknown as ReturnType<typeof scaClient>);

    vi.mocked(slack.conversations.open).mockResolvedValue({
      ok: true,
      channel: { id: "D123" },
    } as never);
    vi.mocked(slack.chat.postMessage).mockResolvedValue({
      ok: true,
      ts: MOCK_TS,
    } as never);
  });

  it("short-circuits on an empty candidate pool: nothing sent, nothing recorded", async () => {
    vi.mocked(selectTopCandidates).mockResolvedValue([]);

    const result = await assembleAndDeliver(profile);

    expect(result).toEqual({ ideaCount: 0, messageTs: null, recorded: false });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("delivers the digest and records it on the happy path", async () => {
    const ideas: Idea[] = [
      mk("idea-1", "Go quiet in the demo"),
      mk("idea-2", "Ask about budget owner"),
    ];
    vi.mocked(selectTopCandidates).mockResolvedValue(ideas);

    const result = await assembleAndDeliver(profile);

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(1);

    const insertArg = insertMock.mock.calls[0][0];
    expect(Object.keys(insertArg).sort()).toEqual(["idea_ids", "message_ts", "rep_id"]);
    expect(insertArg.rep_id).toBe(profile.id);
    expect(insertArg.idea_ids).toEqual(["idea-1", "idea-2"]);
    expect(insertArg.message_ts).toBe(MOCK_TS);

    expect(result).toEqual({ ideaCount: 2, messageTs: MOCK_TS, recorded: true });
  });

  it("does not throw when the sca_digests insert fails after the DM was delivered", async () => {
    const ideas: Idea[] = [mk("idea-1", "Go quiet in the demo")];
    vi.mocked(selectTopCandidates).mockResolvedValue(ideas);
    insertMock.mockResolvedValue({ error: { message: "boom" } });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await assembleAndDeliver(profile);

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ideaCount: 1, messageTs: MOCK_TS, recorded: false });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe("platform value encoding", () => {
  it("round-trips ideaId and selection", () => {
    const v = encodePlatformValue("idea-123", "both");
    expect(v).toBe("idea-123|both");
    expect(parsePlatformValue(v)).toEqual({ ideaId: "idea-123", selection: "both" });
  });
  it("rejects malformed or unknown-selection values", () => {
    expect(parsePlatformValue("no-pipe")).toBeNull();
    expect(parsePlatformValue("idea-1|twitter")).toBeNull();
    expect(parsePlatformValue("|both")).toBeNull();
  });
});

describe("platformsForSelection", () => {
  it("maps each selection to platform list", () => {
    expect(platformsForSelection("linkedin")).toEqual(["linkedin"]);
    expect(platformsForSelection("instagram")).toEqual(["instagram"]);
    expect(platformsForSelection("both")).toEqual(["linkedin", "instagram"]);
  });
});

describe("buildPlatformChoiceBlocks", () => {
  it("asks the platform question with three correctly-encoded buttons", () => {
    const blocks = buildPlatformChoiceBlocks("idea-9");
    const json = JSON.stringify(blocks);
    expect(json).toContain("Which platform(s) will this be posted on?");
    expect(json).toContain(DRAFT_PLATFORM_ACTION);
    expect(json).toContain("idea-9|instagram");
    expect(json).toContain("idea-9|linkedin");
    expect(json).toContain("idea-9|both");
    // Button labels
    expect(json).toContain("Instagram");
    expect(json).toContain("LinkedIn");
    expect(json).toContain("Both");
  });

  it("gives each button a unique action_id (Slack requires uniqueness within an actions block)", () => {
    const blocks = buildPlatformChoiceBlocks("idea-9");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(new Set(ids).size).toBe(3); // all unique
    expect(ids.every((id) => id.startsWith(DRAFT_PLATFORM_ACTION))).toBe(true);
  });
});

describe("buildRetryBlocks", () => {
  it("offers one retry button per failed platform with encoded values and names the good draft", () => {
    const blocks = buildRetryBlocks("idea-7", ["instagram"], "LinkedIn");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn"); // names the draft that landed
    expect(json).toContain("Retry Instagram"); // button label
    expect(json).toContain(DRAFT_RETRY_ACTION);
    expect(json).toContain("idea-7|instagram"); // encoded value
    // exactly one button for one failed platform
    const actions = blocks.find((b) => b.type === "actions") as { elements: unknown[] };
    expect(actions.elements).toHaveLength(1);
  });
  it("supports two failed platforms (two buttons)", () => {
    const blocks = buildRetryBlocks("idea-7", ["linkedin", "instagram"], "");
    const actions = blocks.find((b) => b.type === "actions") as { elements: unknown[] };
    expect(actions.elements).toHaveLength(2);
    const json = JSON.stringify(blocks);
    expect(json).toContain("idea-7|linkedin");
    expect(json).toContain("idea-7|instagram");
  });

  it("gives each retry button a unique action_id", () => {
    const blocks = buildRetryBlocks("idea-7", ["linkedin", "instagram"], "");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith(DRAFT_RETRY_ACTION))).toBe(true);
  });
});

describe("buildOpenerBlocks", () => {
  it("names the platform and the canvas, and carries one Done button", () => {
    const blocks = buildOpenerBlocks("linkedin", "How a demo lands", "cv-1");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn draft");
    expect(json).toContain("LI: How a demo lands"); // canvasTitle output
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].action_id).toBe(DRAFT_DONE_ACTION);
    expect(actions.elements[0].value).toBe("cv-1");
  });
  it("uses IG labeling for instagram", () => {
    const json = JSON.stringify(buildOpenerBlocks("instagram", "A tight hook", "cv-2"));
    expect(json).toContain("Instagram draft");
    expect(json).toContain("IG: A tight hook");
  });
  it("appends the redaction caveat only when wasRedacted", () => {
    const withNote = JSON.stringify(buildOpenerBlocks("linkedin", "h", "cv", { wasRedacted: true }));
    const without = JSON.stringify(buildOpenerBlocks("linkedin", "h", "cv"));
    expect(withNote).toContain("redact");
    expect(without).not.toContain("redact");
  });
});

describe("buildDoneConfirmBlocks", () => {
  it("asks to confirm and offers two uniquely-identified buttons", () => {
    const blocks = buildDoneConfirmBlocks("linkedin", "How a demo lands", "cv-1");
    const json = JSON.stringify(blocks);
    expect(json.toLowerCase()).toContain("can't be undone");
    expect(json).toContain("LI: How a demo lands");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toEqual([DRAFT_DONE_CONFIRM_ACTION, DRAFT_DONE_CANCEL_ACTION]);
    expect(new Set(ids).size).toBe(2); // unique action_ids
  });
});
