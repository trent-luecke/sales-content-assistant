import { getProfileBySlackUser } from "@/lib/profiles";
import { claimIdea, setIdeaStatus } from "@/lib/ideas";
import { readDemoMoment } from "@/lib/mining";
import { generateDraft } from "@/lib/generation";
import { createCanvasInDM } from "@/lib/slack/canvas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";

const OPENER = "First cut's in the canvas above — tell me what to change and I'll rework it.";
const REDACTED_NOTE =
  "\n\n⚠️ Heads up — I had to redact a name to keep this anonymous, so one phrase might " +
  "read a little awkwardly. Worth a quick look before you post.";

// A short Canvas title from the idea's hook.
function draftTitle(hook: string): string {
  const h = hook.trim();
  return h.length > 60 ? `${h.slice(0, 57)}…` : h;
}

// Post a message, optionally in a thread. Never throws (best-effort signal).
async function safePost(channel: string, threadTs: string | undefined, text: string): Promise<void> {
  try {
    await slack.chat.postMessage({ channel, thread_ts: threadTs, text });
  } catch (e) {
    console.error("safePost failed", { channel, error: e });
  }
}

// The thread_ts of the rep's existing draft session for an idea, if any.
async function threadTsForIdea(repId: string, ideaId: string): Promise<string | undefined> {
  const { data } = await scaClient()
    .from("sca_thread_map")
    .select("thread_ts")
    .eq("rep_id", repId)
    .eq("idea_id", ideaId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.thread_ts as string | undefined) ?? undefined;
}

// Handle a "Draft this" click end to end. Runs post-ack (inside waitUntil), so it
// owns all failure handling — nothing here can surface an HTTP error to Slack.
export async function handleDraftThis(payload: unknown): Promise<void> {
  const p = payload as {
    actions?: { value?: unknown }[];
    user?: { id?: unknown };
    channel?: { id?: unknown };
  };
  const ideaId = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (typeof ideaId !== "string" || typeof slackUserId !== "string" || typeof channel !== "string") {
    return;
  }

  const profile = await getProfileBySlackUser(slackUserId);
  if (!profile) {
    await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
    return;
  }

  const claim = await claimIdea(ideaId, profile.id);
  if (claim.outcome === "already_used") {
    const existingTs = await threadTsForIdea(profile.id, ideaId);
    await safePost(channel, existingTs, "You're already drafting this one 👆");
    return;
  }
  if (claim.outcome === "not_found") {
    await safePost(channel, undefined, "Hmm, I couldn't find that idea — grab another from your latest digest.");
    return;
  }

  const idea = claim.idea;
  try {
    const meetingId =
      typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
        ? ((idea.source_ref as { meetingId: string }).meetingId)
        : null;
    const moment = idea.source === "demo" && meetingId ? await readDemoMoment(meetingId) : null;

    const { body, wasRedacted } = await generateDraft(idea, profile, moment);
    const canvasId = await createCanvasInDM(channel, draftTitle(idea.hook), body);

    const posted = await slack.chat.postMessage({
      channel,
      text: wasRedacted ? OPENER + REDACTED_NOTE : OPENER,
    });
    const threadTs = posted.ts;
    if (!threadTs) throw new Error("thread opener returned no ts");

    const { error } = await scaClient().from("sca_thread_map").insert({
      rep_id: profile.id,
      slack_channel: channel,
      thread_ts: threadTs,
      canvas_id: canvasId,
      idea_id: ideaId,
    });
    if (error) throw error;
  } catch (e) {
    // Release the claim so the rep can retry; signal them. Never rethrow (post-ack).
    await setIdeaStatus(ideaId, "candidate").catch(() => {});
    await safePost(channel, undefined, "Something went wrong drafting that — try again in a sec.");
    console.error("handleDraftThis failed", { repId: profile.id, ideaId, error: e });
  }
}
