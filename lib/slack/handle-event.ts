import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { postThreadReply } from "@/lib/slack/client";

// Slack retries deliver the same event_id up to 3x; dedup within the warm instance.
const seen = new Set<string>();

export async function handleEvent(payload: any): Promise<void> {
  const eventId: string | undefined = payload.event_id;
  if (eventId) {
    if (seen.has(eventId)) return;
    seen.add(eventId);
  }
  const event = payload.event;
  if (!event) return;
  // Only respond to human messages / mentions; ignore the bot's own posts and edits.
  if (event.type !== "message" && event.type !== "app_mention") return;
  if (event.bot_id || event.subtype) return;

  const userText: string = event.text ?? "";
  const { text } = await generateText({
    model: anthropic("claude-sonnet-5"),
    prompt: `You are a spike test. Reply in one short sentence confirming you received: "${userText}".`,
  });

  await postThreadReply({
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text,
  });
}
