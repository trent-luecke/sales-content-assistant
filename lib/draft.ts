import { getProfileBySlackUser } from "@/lib/profiles";
import type { Profile } from "@/lib/profiles";
import { claimIdea, setIdeaStatus, getIdea } from "@/lib/ideas";
import type { Idea } from "@/lib/ideas";
import { readDemoMoment } from "@/lib/mining";
import { generateDraft, canvasTitle } from "@/lib/generation";
import type { DemoMoment, Platform } from "@/lib/generation";
import { PLATFORM_LABEL } from "@/lib/generation";
import {
  parsePlatformValue,
  platformsForSelection,
  buildPlatformChoiceBlocks,
  buildRetryBlocks,
  buildOpenerBlocks,
  buildDoneConfirmBlocks,
  DRAFT_DONE_ACTION,
  DRAFT_DONE_CONFIRM_ACTION,
  DRAFT_DONE_CANCEL_ACTION,
} from "@/lib/digest";
import { createCanvasInDM, deleteCanvas } from "@/lib/slack/canvas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";

// The rep's configured platforms, normalized to our lowercase Platform values.
// Empty/unknown -> default to LinkedIn so a rep is never stuck.
function repPlatforms(profile: { channels: unknown[] }): Platform[] {
  const out: Platform[] = [];
  for (const c of profile.channels ?? []) {
    const l = String(c).toLowerCase();
    if (l === "linkedin" && !out.includes("linkedin")) out.push("linkedin");
    if (l === "instagram" && !out.includes("instagram")) out.push("instagram");
  }
  return out.length > 0 ? out : ["linkedin"];
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

// Resolve the draft row for an opener message by its thread_ts (= the opener's own ts).
async function threadMapByThreadTs(
  channel: string,
  threadTs: string,
): Promise<{ canvas_id: string | null; platform: Platform | null; idea_id: string | null; rep_id: string } | null> {
  const { data } = await scaClient()
    .from("sca_thread_map")
    .select("canvas_id, platform, idea_id, rep_id")
    .eq("slack_channel", channel)
    .eq("thread_ts", threadTs)
    .maybeSingle();
  return (data as { canvas_id: string | null; platform: Platform | null; idea_id: string | null; rep_id: string } | null) ?? null;
}

// The hook text for a draft's idea (for rebuilding the LI:/IG: label), or a neutral fallback.
async function hookForRow(row: { idea_id: string | null; rep_id: string }): Promise<string> {
  if (!row.idea_id) return "this draft";
  const idea = await getIdea(row.idea_id, row.rep_id).catch(() => null);
  return idea?.hook ?? "this draft";
}

// The thread_ts of an existing draft session for a specific (idea, platform), if any.
// Used by the retry path so a re-click nudges instead of drafting a duplicate canvas.
async function threadTsForIdeaPlatform(
  repId: string,
  ideaId: string,
  platform: Platform,
): Promise<string | undefined> {
  const { data } = await scaClient()
    .from("sca_thread_map")
    .select("thread_ts")
    .eq("rep_id", repId)
    .eq("idea_id", ideaId)
    .eq("platform", platform)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.thread_ts as string | undefined) ?? undefined;
}

// Claim the idea once, then draft one canvas + thread + sca_thread_map row per
// platform. Runs post-ack; never throws. Total failure releases the claim;
// partial success (Both) keeps it and reports the gap.
async function claimAndDraft(
  ideaId: string,
  profile: Profile,
  channel: string,
  platforms: Platform[],
): Promise<void> {
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

  const label = platforms.map((p) => PLATFORM_LABEL[p]).join(" & ");
  const interim = await slack.chat
    .postMessage({ channel, text: `✍️ Drafting your ${label} draft${platforms.length > 1 ? "s" : ""} in your voice… your ${platforms.length > 1 ? "canvases" : "canvas"} will appear at the top of this chat window in a few seconds.` })
    .catch(() => null);
  const interimTs = interim?.ts;

  // One shared moment read for all platforms.
  const meetingId =
    typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
      ? (idea.source_ref as { meetingId: string }).meetingId
      : null;
  const moment =
    idea.source === "demo" && meetingId
      ? await readDemoMoment(meetingId).catch(() => null)
      : null;

  // Draft each platform independently; the first reuses the interim message as
  // its opener/thread parent, the rest post fresh. Returns ok/fail per platform.
  const results = await Promise.all(
    platforms.map((platform, i) =>
      draftOnePlatform(idea, profile, channel, moment, platform, i === 0 ? interimTs : undefined),
    ),
  );

  const anyOk = results.some((r) => r.ok);
  const anyFail = results.some((r) => !r.ok);

  if (!anyOk) {
    // Total failure: release the claim; turn the interim into an error.
    await setIdeaStatus(ideaId, "candidate").catch(() => {});
    await updateOrPost(channel, interimTs, "Something went wrong drafting that — try again in a sec.");
    return;
  }
  if (anyFail) {
    // Partial (Both): keep the claim (a real draft landed). Offer a working per-platform
    // retry button instead of a dead "click Draft this again" note.
    const failedPlatforms = results.filter((r) => !r.ok).map((r) => r.platform);
    const okLabel = results.filter((r) => r.ok).map((r) => PLATFORM_LABEL[r.platform]).join(" & ");
    const blocks = buildRetryBlocks(ideaId, failedPlatforms, okLabel);
    const text = `I couldn't finish the ${failedPlatforms.map((p) => PLATFORM_LABEL[p]).join(" & ")} draft this time.`;
    // If the interim message belonged to a failed platform (index 0 failed, so it was
    // never converted to an opener), reuse that dangling message as this slot.
    try {
      if (!results[0].ok && interimTs) {
        await slack.chat.update({ channel, ts: interimTs, text, blocks });
      } else {
        await slack.chat.postMessage({ channel, text, blocks });
      }
    } catch (e) {
      console.error("retry-offer post failed", { ideaId, error: e });
    }
  }
}

async function draftOnePlatform(
  idea: Idea,
  profile: Profile,
  channel: string,
  moment: DemoMoment | null,
  platform: Platform,
  reuseTs: string | undefined,
): Promise<{ ok: boolean; platform: Platform }> {
  try {
    const { body, wasRedacted } = await generateDraft(idea, profile, moment, platform);
    const canvasId = await createCanvasInDM(channel, canvasTitle(platform, idea.hook), body);

    const openerBlocks = buildOpenerBlocks(platform, idea.hook, canvasId, { wasRedacted });
    const openerFallback = `${PLATFORM_LABEL[platform]} draft ready — see the canvas above.`;
    let threadTs = reuseTs;
    if (reuseTs) {
      await slack.chat.update({ channel, ts: reuseTs, text: openerFallback, blocks: openerBlocks });
    } else {
      const op = await slack.chat.postMessage({ channel, text: openerFallback, blocks: openerBlocks });
      threadTs = op.ts;
    }
    if (!threadTs) throw new Error("no thread ts for draft session");

    const { error } = await scaClient().from("sca_thread_map").insert({
      rep_id: profile.id,
      slack_channel: channel,
      thread_ts: threadTs,
      canvas_id: canvasId,
      idea_id: idea.id,
      platform,
    });
    if (error) throw error;
    return { ok: true, platform };
  } catch (e) {
    console.error("draftOnePlatform failed", { repId: profile.id, ideaId: idea.id, platform, error: e });
    return { ok: false, platform };
  }
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

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    const platforms = repPlatforms(profile);
    if (platforms.length > 1) {
      // Both channels: ask before committing (no claim yet).
      await slack.chat
        .postMessage({ channel, blocks: buildPlatformChoiceBlocks(ideaId), text: "Which platform(s) will this be posted on?" })
        .catch((e) => console.error("platform choice post failed", { ideaId, error: e }));
      return;
    }
    await claimAndDraft(ideaId, profile, channel, platforms);
  } catch (e) {
    await safePost(channel, undefined, "Something went wrong — try again in a sec.");
    console.error("handleDraftThis failed (pre-claim)", { slackUserId, ideaId, error: e });
  }
}

export async function handleDraftPlatform(payload: unknown): Promise<void> {
  const p = payload as { actions?: { value?: unknown }[]; user?: { id?: unknown }; channel?: { id?: unknown } };
  const rawValue = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (typeof rawValue !== "string" || typeof slackUserId !== "string" || typeof channel !== "string") return;

  const parsed = parsePlatformValue(rawValue);
  if (!parsed) return;

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    await claimAndDraft(parsed.ideaId, profile, channel, platformsForSelection(parsed.selection));
  } catch (e) {
    await safePost(channel, undefined, "Something went wrong — try again in a sec.");
    console.error("handleDraftPlatform failed (pre-claim)", { slackUserId, ideaId: parsed.ideaId, error: e });
  }
}

// Handle a "Retry {platform}" click: re-draft ONE platform of an already-`used` idea
// without re-claiming. Runs post-ack (inside waitUntil); must never throw.
export async function handleDraftRetry(payload: unknown): Promise<void> {
  const p = payload as { actions?: { value?: unknown }[]; user?: { id?: unknown }; channel?: { id?: unknown } };
  const rawValue = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (typeof rawValue !== "string" || typeof slackUserId !== "string" || typeof channel !== "string") return;

  const parsed = parsePlatformValue(rawValue);
  if (!parsed || parsed.selection === "both") return; // retry is single-platform only
  const platform: Platform = parsed.selection; // narrowed to "linkedin" | "instagram"

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    const idea = await getIdea(parsed.ideaId, profile.id);
    if (!idea) {
      await safePost(channel, undefined, "Hmm, I couldn't find that idea — grab another from your latest digest.");
      return;
    }
    // Idempotency: already have a draft session for this (idea, platform)? Nudge, don't duplicate.
    const existingTs = await threadTsForIdeaPlatform(profile.id, parsed.ideaId, platform);
    if (existingTs) {
      await safePost(channel, existingTs, `You're already drafting the ${PLATFORM_LABEL[platform]} version 👆`);
      return;
    }
    const interim = await slack.chat
      .postMessage({ channel, text: `✍️ Retrying your ${PLATFORM_LABEL[platform]} draft… your canvas will appear at the top of this chat window in a few seconds.` })
      .catch(() => null);
    const meetingId =
      typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
        ? (idea.source_ref as { meetingId: string }).meetingId
        : null;
    const moment =
      idea.source === "demo" && meetingId
        ? await readDemoMoment(meetingId).catch(() => null)
        : null;
    const result = await draftOnePlatform(idea, profile, channel, moment, platform, interim?.ts);
    if (!result.ok) {
      await updateOrPost(channel, interim?.ts, `Still couldn't draft the ${PLATFORM_LABEL[platform]} one — try again in a sec.`);
    }
  } catch (e) {
    await safePost(channel, undefined, "Something went wrong — try again in a sec.");
    console.error("handleDraftRetry failed (pre-draft)", { slackUserId, ideaId: parsed.ideaId, error: e });
  }
}

// Shared payload shape for the cleanup handlers (buttons live on the opener message).
type CleanupPayload = {
  actions?: { value?: unknown }[];
  channel?: { id?: unknown };
  message?: { ts?: unknown };
  container?: { message_ts?: unknown };
};
function cleanupCoords(payload: unknown): { channel: string; ts: string } | null {
  const p = payload as CleanupPayload;
  const channel = p?.channel?.id;
  const ts = p?.message?.ts ?? p?.container?.message_ts;
  if (typeof channel !== "string" || typeof ts !== "string") return null;
  return { channel, ts };
}

// Done clicked → swap the opener to the confirm prompt (state 1 → 2). Never throws.
export async function handleDraftDone(payload: unknown): Promise<void> {
  const c = cleanupCoords(payload);
  if (!c) return;
  try {
    const row = await threadMapByThreadTs(c.channel, c.ts);
    if (!row || !row.platform) {
      await safePost(c.channel, c.ts, "I couldn't find that draft to clean up.");
      return;
    }
    const hook = await hookForRow(row);
    await slack.chat.update({
      channel: c.channel,
      ts: c.ts,
      text: "Delete this draft's canvas?",
      blocks: buildDoneConfirmBlocks(row.platform, hook, row.canvas_id ?? ""),
    });
  } catch (e) {
    console.error("handleDraftDone failed", { channel: c.channel, ts: c.ts, error: e });
  }
}

// Yes,delete clicked → delete the canvas, null the row's canvas_id, show Cleared (state 2 → 3).
// Idempotent (canvas_id already null → just show Cleared); on delete error, keep the confirm
// message and post a soft retry note. Never throws.
export async function handleDraftDoneConfirm(payload: unknown): Promise<void> {
  const c = cleanupCoords(payload);
  if (!c) return;
  try {
    const row = await threadMapByThreadTs(c.channel, c.ts);
    if (!row || !row.platform) {
      await safePost(c.channel, c.ts, "I couldn't find that draft to clean up.");
      return;
    }
    const cleared = `Cleared ✅ — ${PLATFORM_LABEL[row.platform]} draft canvas removed.`;
    if (!row.canvas_id) {
      await slack.chat.update({ channel: c.channel, ts: c.ts, text: cleared, blocks: [] }).catch(() => {});
      return;
    }
    try {
      await deleteCanvas(row.canvas_id);
    } catch (e) {
      console.error("deleteCanvas failed", { channel: c.channel, ts: c.ts, error: e });
      await safePost(c.channel, c.ts, "Couldn't remove that just now — hit Yes, delete again in a sec.");
      return; // leave the confirm message intact so the buttons remain
    }
    const { error } = await scaClient()
      .from("sca_thread_map")
      .update({ canvas_id: null })
      .eq("slack_channel", c.channel)
      .eq("thread_ts", c.ts);
    if (error) console.error("null canvas_id failed after delete", { channel: c.channel, ts: c.ts, error });
    await slack.chat.update({ channel: c.channel, ts: c.ts, text: cleared, blocks: [] }).catch(() => {});
  } catch (e) {
    console.error("handleDraftDoneConfirm failed", { channel: c.channel, ts: c.ts, error: e });
  }
}

// Keep clicked → revert the opener to state 1. Never throws. (Redaction caveat is not persisted,
// so the reverted opener omits it — accepted minor.)
export async function handleDraftDoneCancel(payload: unknown): Promise<void> {
  const c = cleanupCoords(payload);
  if (!c) return;
  try {
    const row = await threadMapByThreadTs(c.channel, c.ts);
    if (!row || !row.platform) return;
    const hook = await hookForRow(row);
    await slack.chat.update({
      channel: c.channel,
      ts: c.ts,
      text: `${PLATFORM_LABEL[row.platform]} draft ready — see the canvas above.`,
      blocks: buildOpenerBlocks(row.platform, hook, row.canvas_id ?? ""),
    });
  } catch (e) {
    console.error("handleDraftDoneCancel failed", { channel: c.channel, ts: c.ts, error: e });
  }
}
