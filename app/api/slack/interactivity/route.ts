import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "@/lib/slack/verify";
import { handleDraftThis, handleDraftPlatform, handleDraftRetry } from "@/lib/draft";
import { DRAFT_THIS_ACTION, DRAFT_PLATFORM_ACTION, DRAFT_RETRY_ACTION } from "@/lib/digest";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // RAG read + up to two model calls + Canvas create

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  // Interactivity payloads are form-encoded: a single `payload` field holding JSON.
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return new Response(null, { status: 200 });
  let payload: { type?: string; actions?: { action_id?: string }[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 200 });
  }

  if (payload.type === "block_actions") {
    const actionId = payload.actions?.[0]?.action_id ?? "";
    if (actionId === DRAFT_THIS_ACTION) {
      waitUntil(handleDraftThis(payload)); // ack now, do slow work after responding
    } else if (actionId.startsWith(DRAFT_PLATFORM_ACTION)) {
      waitUntil(handleDraftPlatform(payload));
    } else if (actionId.startsWith(DRAFT_RETRY_ACTION)) {
      waitUntil(handleDraftRetry(payload));
    }
  }
  return new Response(null, { status: 200 });
}
