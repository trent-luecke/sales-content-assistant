import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDigestHeaderBlocks,
  buildIdeaBlocks,
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
  buildReplaceConfirmBlocks,
  DRAFT_REPLACE_CONFIRM_ACTION,
  DRAFT_REPLACE_CANCEL_ACTION,
  REFINE_ACTION,
  parseRefineKind,
} from "@/lib/digest";
import { REFINE_KINDS } from "@/lib/generation";
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

describe("buildDigestHeaderBlocks", () => {
  it("returns a single framing section, no buttons", () => {
    const blocks = buildDigestHeaderBlocks();
    expect(types(blocks)).toEqual(["section"]);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("worth saying this week");
  });
});

describe("buildIdeaBlocks", () => {
  it("renders one idea as a section + a single Draft this button carrying the idea id", () => {
    const blocks = buildIdeaBlocks(mk("id-1", "Go quiet in the demo"));
    expect(types(blocks)).toEqual(["section", "actions"]);
    const body = blocks[0] as any;
    expect(body.text.type).toBe("mrkdwn");
    expect(body.text.text).toContain("Go quiet in the demo");
    expect(body.text.text).toContain("why Go quiet in the demo lands");
    const btns = buttons(blocks);
    expect(btns).toHaveLength(1);
    expect(btns[0].action_id).toBe(DRAFT_THIS_ACTION);
    expect(btns[0].value).toBe("id-1");
    expect(DRAFT_THIS_ACTION).toBe("draft_this");
  });

  it("throws when an idea is missing its id", () => {
    const noId = { ...mk("x", "hook"), id: undefined } as Idea;
    expect(() => buildIdeaBlocks(noId)).toThrow(/missing an id/);
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

  it("delivers a header + one message per idea and records it on the happy path", async () => {
    const ideas: Idea[] = [
      mk("idea-1", "Go quiet in the demo"),
      mk("idea-2", "Ask about budget owner"),
    ];
    vi.mocked(selectTopCandidates).mockResolvedValue(ideas);
    // Distinct per-call ts values so the header ts is provably the one recorded
    // (a constant ts across all calls wouldn't discriminate header vs. idea posts).
    vi.mocked(slack.chat.postMessage)
      .mockResolvedValueOnce({ ok: true, ts: "header-ts" } as never)
      .mockResolvedValueOnce({ ok: true, ts: "idea-1-ts" } as never)
      .mockResolvedValueOnce({ ok: true, ts: "idea-2-ts" } as never);

    const result = await assembleAndDeliver(profile);

    // 1 header + 2 idea messages
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(slack.chat.postMessage).mock.calls;
    // First post is the header — no Draft this button.
    expect(JSON.stringify((calls[0][0] as any).blocks)).not.toContain(DRAFT_THIS_ACTION);
    // The two idea posts each carry a Draft this button with the idea id.
    expect(JSON.stringify((calls[1][0] as any).blocks)).toContain("idea-1");
    expect(JSON.stringify((calls[2][0] as any).blocks)).toContain("idea-2");

    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertArg = insertMock.mock.calls[0][0];
    expect(insertArg.rep_id).toBe(profile.id);
    expect(insertArg.idea_ids).toEqual(["idea-1", "idea-2"]);
    expect(insertArg.message_ts).toBe("header-ts");

    expect(result).toEqual({ ideaCount: 2, messageTs: "header-ts", recorded: true });
  });

  it("does not throw when the sca_digests insert fails after the DM was delivered", async () => {
    const ideas: Idea[] = [mk("idea-1", "Go quiet in the demo")];
    vi.mocked(selectTopCandidates).mockResolvedValue(ideas);
    vi.mocked(slack.chat.postMessage)
      .mockResolvedValueOnce({ ok: true, ts: "header-ts" } as never)
      .mockResolvedValueOnce({ ok: true, ts: "idea-1-ts" } as never);
    insertMock.mockResolvedValue({ error: { message: "boom" } });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await assembleAndDeliver(profile);

    // header + 1 idea message
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ideaCount: 1, messageTs: "header-ts", recorded: false });
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
  it("has a section plus an actions block", () => {
    const blocks = buildOpenerBlocks("idea-1", "linkedin");
    expect(types(blocks)).toEqual(["section", "actions"]);
  });

  it("names the platform in the section copy", () => {
    expect(JSON.stringify(buildOpenerBlocks("idea-1", "instagram"))).toContain("Instagram");
  });

  it("emits one refine button per kind, each with a unique action_id", () => {
    const blocks = buildOpenerBlocks("idea-1", "linkedin");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    expect(actions.elements).toHaveLength(REFINE_KINDS.length);
    const ids = actions.elements.map((e) => e.action_id);
    expect(new Set(ids).size).toBe(REFINE_KINDS.length); // all unique
    for (const id of ids) expect(id.startsWith("refine:")).toBe(true);
  });

  it("every refine button carries the ideaId|platform value", () => {
    const blocks = buildOpenerBlocks("idea-1", "linkedin");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { value: string }[] };
    for (const el of actions.elements) expect(el.value).toBe("idea-1|linkedin");
  });

  it("appends the redaction caveat only when wasRedacted is set", () => {
    const withNote = JSON.stringify(buildOpenerBlocks("idea-1", "linkedin", { wasRedacted: true }));
    const without = JSON.stringify(buildOpenerBlocks("idea-1", "linkedin"));
    expect(withNote).toContain("redact");
    expect(without).not.toContain("redact");
  });
});

describe("parseRefineKind", () => {
  it("returns the kind for a valid refine action_id", () => {
    expect(parseRefineKind("refine:shorter")).toBe("shorter");
    expect(parseRefineKind("refine:different_angle")).toBe("different_angle");
  });
  it("returns null for an unknown kind", () => {
    expect(parseRefineKind("refine:bogus")).toBeNull();
  });
  it("returns null when the prefix is wrong", () => {
    expect(parseRefineKind("draft_this")).toBeNull();
    expect(parseRefineKind("shorter")).toBeNull();
  });
});

describe("buildReplaceConfirmBlocks", () => {
  it("names the platform, references the new hook, and offers two uniquely-identified buttons", () => {
    const blocks = buildReplaceConfirmBlocks("idea-5", "linkedin", "How a demo lands");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn");
    expect(json).toContain("How a demo lands");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toEqual([DRAFT_REPLACE_CONFIRM_ACTION, DRAFT_REPLACE_CANCEL_ACTION]);
    expect(new Set(ids).size).toBe(2); // unique action_ids
  });

  it("encodes <ideaId>|<platform> on both buttons and round-trips via parsePlatformValue", () => {
    const blocks = buildReplaceConfirmBlocks("idea-5", "instagram", "hook");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { value: string }[] };
    for (const el of actions.elements) {
      expect(el.value).toBe("idea-5|instagram");
      expect(parsePlatformValue(el.value)).toEqual({ ideaId: "idea-5", selection: "instagram" });
    }
  });

  it("neither action_id prefixes the other (safe for exact-match routing)", () => {
    expect(DRAFT_REPLACE_CONFIRM_ACTION.startsWith(DRAFT_REPLACE_CANCEL_ACTION)).toBe(false);
    expect(DRAFT_REPLACE_CANCEL_ACTION.startsWith(DRAFT_REPLACE_CONFIRM_ACTION)).toBe(false);
  });
});
