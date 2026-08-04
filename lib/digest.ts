import type { KnownBlock } from "@slack/web-api";
import type { Idea } from "@/lib/ideas";

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
          value: idea.id ?? "",
        },
      ],
    });
  });

  return blocks;
}
