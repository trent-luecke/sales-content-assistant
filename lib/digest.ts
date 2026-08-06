import type { KnownBlock } from "@slack/web-api";
import type { Idea } from "@/lib/ideas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";
import { selectTopCandidates } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";
import type { Platform } from "@/lib/generation";

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

// Pure: shape the platform-choice message for a single idea — one section
// asking which platform(s), and three buttons (Instagram / LinkedIn / Both)
// each carrying the draft_platform action_id and an encoded value.
export function buildPlatformChoiceBlocks(ideaId: string): KnownBlock[] {
  const button = (text: string, selection: PlatformSelection) => ({
    type: "button" as const,
    text: { type: "plain_text" as const, text },
    action_id: DRAFT_PLATFORM_ACTION,
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

// Pure: shape ideas into a single Block Kit message. Header, then per idea a
// section (bold hook + rationale) and an actions block with one "Draft this"
// button; dividers separate ideas but never trail the last one.
export function buildDigestBlocks(ideas: Idea[]): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Here are a few things worth saying this week.",
      },
    },
  ];

  ideas.forEach((idea, i) => {
    if (!idea.id) {
      throw new Error("buildDigestBlocks: idea is missing an id (cannot build a draft_this button)");
    }
    if (i > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${idea.hook}*\n${idea.rationale}` },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Draft this" },
          action_id: DRAFT_THIS_ACTION,
          value: idea.id,
        },
      ],
    });
  });

  return blocks;
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

  const blocks = buildDigestBlocks(ideas);
  const fallback = `You have ${ideas.length} content idea${ideas.length === 1 ? "" : "s"} ready.`;

  // Open (or reuse) the bot↔rep DM, then post the digest there.
  const opened = await slack.conversations.open({ users: profile.slack_user_id });
  const channel = opened.channel?.id;
  if (!channel) throw new Error("could not open DM channel for rep");

  const posted = await slack.chat.postMessage({ channel, blocks, text: fallback });
  const messageTs = posted.ts ?? null;

  // Record the delivery. idea ids are non-null here (rows came from the DB).
  // The DM already went out — a logging failure here must not surface as an
  // error to the caller (that would trigger a retry and a second DM).
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
