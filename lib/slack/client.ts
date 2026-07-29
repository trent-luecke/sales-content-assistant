import { WebClient } from "@slack/web-api";

export const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function postThreadReply(args: {
  channel: string;
  threadTs?: string;
  text: string;
}): Promise<void> {
  await slack.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text,
  });
}
