import { getProfileBySlackUser } from "@/lib/profiles";
import { claimIdea, setIdeaStatus } from "@/lib/ideas";
import { readDemoMoment } from "@/lib/mining";
import { generateDraft } from "@/lib/generation";
import { createCanvasInDM } from "@/lib/slack/canvas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";

// Immediate acknowledgement so the multi-second generation doesn't read as a
// dead click. Posted right after the claim, then updated in place to the opener.
const DRAFTING = "✍️ Drafting this in your voice… your canvas will appear here in a few seconds.";
const OPENER = "First cut's in the canvas — tell me what to change and I'll rework it.";
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

// Update an existing message in place (used to turn the "drafting…" note into
// the opener / an error), or post fresh if we never got an interim ts. Never throws.
async function updateOrPost(channel: string, ts: string | undefined, text: string): Promise<void> {
  try {
    if (ts) await slack.chat.update({ channel, ts, text });
    else await slack.chat.postMessage({ channel, text });
  } catch (e) {
    console.error("updateOrPost failed", { channel, error: e });
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

  // Runs post-ack inside waitUntil — this function must never throw. An outer
  // try guards the pre-claim reads (profile resolve, claim, thread lookup); the
  // inner try guards the claimed path and additionally releases the claim.
  try {
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
    // Immediate feedback before the slow generation. This message becomes the
    // iteration thread's parent and is updated in place once the canvas is ready.
    const interim = await slack.chat.postMessage({ channel, text: DRAFTING }).catch(() => null);
    const interimTs = interim?.ts;
    try {
      const meetingId =
        typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
          ? (idea.source_ref as { meetingId: string }).meetingId
          : null;
      // A bad/missing source moment must never fail the draft — fall back to the
      // profile-only (organic) path if the RAG read errors or the ref is invalid.
      const moment =
        idea.source === "demo" && meetingId
          ? await readDemoMoment(meetingId).catch(() => null)
          : null;

      const { body, wasRedacted } = await generateDraft(idea, profile, moment);
      const canvasId = await createCanvasInDM(channel, draftTitle(idea.hook), body);

      // Turn the "drafting…" note into the opener (or post fresh if it didn't post).
      const openerText = wasRedacted ? OPENER + REDACTED_NOTE : OPENER;
      let threadTs = interimTs;
      if (interimTs) {
        await slack.chat.update({ channel, ts: interimTs, text: openerText });
      } else {
        const op = await slack.chat.postMessage({ channel, text: openerText });
        threadTs = op.ts;
      }
      if (!threadTs) throw new Error("no thread ts for draft session");

      const { error } = await scaClient().from("sca_thread_map").insert({
        rep_id: profile.id,
        slack_channel: channel,
        thread_ts: threadTs,
        canvas_id: canvasId,
        idea_id: ideaId,
      });
      if (error) throw error;
    } catch (e) {
      // Post-claim failure: release the claim so the rep can retry; turn the
      // "drafting…" note into the error (or post fresh if it never posted).
      await setIdeaStatus(ideaId, "candidate").catch(() => {});
      await updateOrPost(channel, interimTs, "Something went wrong drafting that — try again in a sec.");
      console.error("handleDraftThis failed (post-claim)", { repId: profile.id, ideaId, error: e });
    }
  } catch (e) {
    // Pre-claim failure (profile resolve / claim / thread lookup threw): nothing
    // was claimed, so nothing to release — just signal the rep and log.
    await safePost(channel, undefined, "Something went wrong — try again in a sec.");
    console.error("handleDraftThis failed (pre-claim)", { slackUserId, ideaId, error: e });
  }
}
