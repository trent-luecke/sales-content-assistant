import { getProfileBySlackUser } from "@/lib/profiles";
import { readRepDemos, filterUnminedDemos, mineIdeas } from "@/lib/mining";
import { existingHooks, minedMeetingIds, dedupeIdeas, insertIdeas } from "@/lib/ideas";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // reads demos + runs the mining model

export async function POST(req: Request) {
  // Internal write endpoint — gate behind a shared secret, fail closed.
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

  // Only mine demos we haven't already turned into ideas.
  const demos = await readRepDemos(profile.avoma_rep_name, 8);
  const unmined = filterUnminedDemos(demos, await minedMeetingIds(profile.id));
  if (unmined.length === 0) {
    return Response.json({ repId: profile.id, demosMined: 0, inserted: 0, reason: "no new demos" });
  }

  // Mine (guardrail enforced inside mineIdeas) → dedup against existing hooks → insert.
  const candidates = await mineIdeas(profile.id, unmined, { angle: profile.angle ?? "" });
  const fresh = dedupeIdeas(await existingHooks(profile.id), candidates);
  await insertIdeas(fresh);

  return Response.json({
    repId: profile.id,
    demosMined: unmined.length,
    generated: candidates.length,
    inserted: fresh.length,
  });
}
