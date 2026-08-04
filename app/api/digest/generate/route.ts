import { getProfileBySlackUser } from "@/lib/profiles";
import { assembleAndDeliver } from "@/lib/digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Slack DM round-trip + DB write

export async function POST(req: Request) {
  // Internal endpoint — gate behind a shared secret, fail closed.
  const key = process.env.SCA_INTERNAL_KEY;
  if (!key) return Response.json({ error: "not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${key}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const slackUserId = (body as { slackUserId?: unknown })?.slackUserId;
  if (typeof slackUserId !== "string" || slackUserId.length === 0) {
    return Response.json({ error: "missing slackUserId" }, { status: 400 });
  }

  // Resolve the rep fresh from the request — never trust a client-supplied id.
  const profile = await getProfileBySlackUser(slackUserId);
  if (!profile) return new Response("not found", { status: 404 });
  if (profile.status !== "active") {
    return Response.json({ error: "profile not active" }, { status: 409 });
  }

  const { ideaCount, messageTs, recorded } = await assembleAndDeliver(profile);
  return Response.json({ repId: profile.id, ideaCount, messageTs, recorded });
}
