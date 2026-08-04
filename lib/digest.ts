import type { KnownBlock } from "@slack/web-api";
import type { Idea } from "@/lib/ideas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";
import { selectTopCandidates } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

// The button contract shared with the interactivity endpoint (Phase 1 step 6):
// every "Draft this" button carries this action_id and the idea's uuid as value.
export const DRAFT_THIS_ACTION = "draft_this";

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
export async function assembleAndDeliver(
  profile: Profile,
): Promise<{ ideaCount: number; messageTs: string | null }> {
  const ideas = await selectTopCandidates(profile.id, 3);
  if (ideas.length === 0) return { ideaCount: 0, messageTs: null };

  const blocks = buildDigestBlocks(ideas);
  const fallback = `You have ${ideas.length} content idea${ideas.length === 1 ? "" : "s"} ready.`;

  // Open (or reuse) the bot↔rep DM, then post the digest there.
  const opened = await slack.conversations.open({ users: profile.slack_user_id });
  const channel = opened.channel?.id;
  if (!channel) throw new Error("could not open DM channel for rep");

  const posted = await slack.chat.postMessage({ channel, blocks, text: fallback });
  const messageTs = posted.ts ?? null;

  // Record the delivery. idea ids are non-null here (rows came from the DB).
  const { error } = await scaClient().from("sca_digests").insert({
    rep_id: profile.id,
    idea_ids: ideas.map((i) => i.id),
    message_ts: messageTs,
  });
  if (error) throw error;

  return { ideaCount: ideas.length, messageTs };
}
