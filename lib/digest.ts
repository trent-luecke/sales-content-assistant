import type { KnownBlock } from "@slack/web-api";
import type { Idea } from "@/lib/ideas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";
import { selectTopCandidates } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";
import type { Platform, RefineKind } from "@/lib/generation";
import { PLATFORM_LABEL, REFINE_KINDS, REFINE_LABEL } from "@/lib/generation";

// The button contract shared with the interactivity endpoint (Phase 1 step 6):
// every "Draft this" button carries this action_id and the idea's uuid as value.
export const DRAFT_THIS_ACTION = "draft_this";

// The platform-choice message posted for both-channel reps after "Draft this":
// each button carries this action_id and an encoded "<ideaId>|<selection>" value.
export const DRAFT_PLATFORM_ACTION = "draft_platform";
export type PlatformSelection = "linkedin" | "instagram" | "both";

export function encodePlatformValue(ideaId: string, selection: PlatformSelection): string {
  return `${ideaId}|${selection}`;
}

export function parsePlatformValue(
  value: string,
): { ideaId: string; selection: PlatformSelection } | null {
  const i = value.indexOf("|");
  if (i <= 0) return null; // no pipe, or empty ideaId
  const ideaId = value.slice(0, i);
  const sel = value.slice(i + 1);
  if (sel !== "linkedin" && sel !== "instagram" && sel !== "both") return null;
  return { ideaId, selection: sel };
}

export function platformsForSelection(selection: PlatformSelection): Platform[] {
  return selection === "both" ? ["linkedin", "instagram"] : [selection];
}

export const DRAFT_RETRY_ACTION = "draft_retry";

export const DRAFT_REPLACE_CONFIRM_ACTION = "draft_replace_confirm";
export const DRAFT_REPLACE_CANCEL_ACTION = "draft_replace_cancel";

// Refine buttons under a draft opener: action_id is `refine:<kind>`, value is the
// shared "<ideaId>|<platform>" encoding. Each kind gets a unique action_id.
export const REFINE_ACTION = "refine";

export function parseRefineKind(actionId: string): RefineKind | null {
  const prefix = `${REFINE_ACTION}:`;
  if (!actionId.startsWith(prefix)) return null;
  const kind = actionId.slice(prefix.length);
  return (REFINE_KINDS as readonly string[]).includes(kind) ? (kind as RefineKind) : null;
}

// The one-time heads-up appended to an opener when a name had to be redacted.
export const REDACTED_NOTE =
  "\n\n⚠️ Heads up — I had to redact a name to keep this anonymous, so one phrase might " +
  "read a little awkwardly. Worth a quick look before you post.";

// Posted on a "Both" partial failure: a short message naming the draft that DID
// land, plus one "Retry {label}" button per failed platform. The button reuses the
// "<ideaId>|<platform>" value encoding, so parsePlatformValue parses it too.
export function buildRetryBlocks(
  ideaId: string,
  failedPlatforms: Platform[],
  okLabel: string,
): KnownBlock[] {
  const failedLabel = failedPlatforms.map((p) => PLATFORM_LABEL[p]).join(" & ");
  const lead = okLabel
    ? `Your ${okLabel} draft is ready 👆 — I couldn't finish the ${failedLabel} one this time.`
    : `I couldn't finish the ${failedLabel} draft this time.`;
  return [
    { type: "section", text: { type: "mrkdwn", text: lead } },
    {
      type: "actions",
      elements: failedPlatforms.map((p) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: `Retry ${PLATFORM_LABEL[p]}` },
        action_id: `${DRAFT_RETRY_ACTION}:${p}`,
        value: encodePlatformValue(ideaId, p),
      })),
    },
  ];
}

// Pure: shape the platform-choice message for a single idea — one section
// asking which platform(s), and three buttons (Instagram / LinkedIn / Both)
// each carrying the draft_platform action_id and an encoded value.
export function buildPlatformChoiceBlocks(ideaId: string): KnownBlock[] {
  const button = (text: string, selection: PlatformSelection) => ({
    type: "button" as const,
    text: { type: "plain_text" as const, text },
    action_id: `${DRAFT_PLATFORM_ACTION}:${selection}`,
    value: encodePlatformValue(ideaId, selection),
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Which platform(s) will this be posted on?" },
    },
    {
      type: "actions",
      elements: [
        button("Instagram", "instagram"),
        button("LinkedIn", "linkedin"),
        button("Both", "both"),
      ],
    },
  ];
}

// Pure: the digest's lead-in message — one framing section, no buttons.
export function buildDigestHeaderBlocks(): KnownBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Here are a few things worth saying this week." },
    },
  ];
}

// Pure: one idea as its own message — a section (bold hook + rationale) and an actions
// block with a single "Draft this" button carrying the idea id. This message's ts becomes
// the idea's thread root, so drafting nests under it.
export function buildIdeaBlocks(idea: Idea): KnownBlock[] {
  if (!idea.id) {
    throw new Error("buildIdeaBlocks: idea is missing an id (cannot build a draft_this button)");
  }
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${idea.hook}*\n${idea.rationale}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Draft this" },
          action_id: DRAFT_THIS_ACTION,
          value: idea.id,
        },
      ],
    },
  ];
}

// Select the rep's top candidate ideas, DM them the digest with "Draft this"
// buttons, and record what was sent. Sends whatever is available (1-3); if the
// pool is empty it sends nothing and records nothing, returning ideaCount: 0.
//
// The DM send is irreversible; the sca_digests insert that logs it is not
// allowed to turn that into a failure. Once the DM is posted, this function
// always returns normally (never throws) — if the insert fails, it logs
// loudly via console.error and returns recorded: false so the caller can
// still respond 200 without triggering a retry that would double-send the DM.
export async function assembleAndDeliver(
  profile: Profile,
): Promise<{ ideaCount: number; messageTs: string | null; recorded: boolean }> {
  const ideas = await selectTopCandidates(profile.id, 3);
  if (ideas.length === 0) return { ideaCount: 0, messageTs: null, recorded: false };

  // Open (or reuse) the bot↔rep DM.
  const opened = await slack.conversations.open({ users: profile.slack_user_id });
  const channel = opened.channel?.id;
  if (!channel) throw new Error("could not open DM channel for rep");

  // Header message first — its ts is the delivery marker we record.
  const headerFallback = `You have ${ideas.length} content idea${ideas.length === 1 ? "" : "s"} ready.`;
  const header = await slack.chat.postMessage({ channel, blocks: buildDigestHeaderBlocks(), text: headerFallback });
  const messageTs = header.ts ?? null;

  // Then one top-level message per idea; each becomes that idea's thread root.
  for (const idea of ideas) {
    await slack.chat.postMessage({ channel, blocks: buildIdeaBlocks(idea), text: `Draft idea: ${idea.hook}` });
  }

  // Record the delivery. The DM already went out — a logging failure must not surface as an
  // error (that would trigger a retry and a duplicate send).
  let recorded = false;
  try {
    const { error } = await scaClient().from("sca_digests").insert({
      rep_id: profile.id,
      idea_ids: ideas.map((i) => i.id),
      message_ts: messageTs,
    });
    if (error) {
      console.error("sca_digests insert failed after DM delivered", { repId: profile.id, messageTs, error });
    } else {
      recorded = true;
    }
  } catch (error) {
    console.error("sca_digests insert failed after DM delivered", { repId: profile.id, messageTs, error });
  }

  return { ideaCount: ideas.length, messageTs, recorded };
}

// The replace-confirm prompt shown when a rep drafts a new idea for a platform that
// already has a canvas. Two uniquely-identified buttons, both carrying the
// "<ideaId>|<platform>" value so the confirm/cancel handlers know what to draft.
export function buildReplaceConfirmBlocks(
  ideaId: string,
  platform: Platform,
  hook: string,
): KnownBlock[] {
  const value = encodePlatformValue(ideaId, platform);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `You have a current *${PLATFORM_LABEL[platform]}* draft in its canvas. ` +
          `Replace it with a new draft for *${hook}*?`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Replace" },
          action_id: DRAFT_REPLACE_CONFIRM_ACTION,
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Keep current" },
          action_id: DRAFT_REPLACE_CANCEL_ACTION,
          value,
        },
      ],
    },
  ];
}

// The draft's opener message: platform-labeled, with the refine buttons that drive the
// step-7 iteration loop. Each button carries the "<ideaId>|<platform>" value and a
// unique `refine:<kind>` action_id. A new opener is posted per draft; the canvas is reused.
export function buildOpenerBlocks(
  ideaId: string,
  platform: Platform,
  opts?: { wasRedacted?: boolean },
): KnownBlock[] {
  const caveat = opts?.wasRedacted ? REDACTED_NOTE : "";
  const value = encodePlatformValue(ideaId, platform);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Your *${PLATFORM_LABEL[platform]}* draft is in the canvas at the top of this chat. ` +
          `Want a tweak? Tap a button and I'll update the canvas in place.${caveat}`,
      },
    },
    {
      type: "actions",
      elements: REFINE_KINDS.map((kind) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: REFINE_LABEL[kind] },
        action_id: `${REFINE_ACTION}:${kind}`,
        value,
      })),
    },
  ];
}
