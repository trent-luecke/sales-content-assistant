import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "@/lib/slack/verify";
import { handleEvent } from "@/lib/slack/handle-event";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payload = JSON.parse(rawBody);
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  waitUntil(handleEvent(payload)); // ack now, finish slow work after responding
  return new Response(null, { status: 200 });
}
