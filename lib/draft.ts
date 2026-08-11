import { getProfileBySlackUser } from "@/lib/profiles";
import type { Profile } from "@/lib/profiles";
import { claimIdea, getIdea } from "@/lib/ideas";
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
  buildReplaceConfirmBlocks,
} from "@/lib/digest";
import { createCanvasInDM, editCanvas } from "@/lib/slack/canvas";
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

// The reusable canvas for (rep, platform): the canvas_id of the most recent
// sca_thread_map row for that rep + platform with a non-null canvas_id, or null.
async function currentCanvasId(repId: string, platform: Platform): Promise<string | null> {
  const { data } = await scaClient()
    .from("sca_thread_map")
    .select("canvas_id")
    .eq("rep_id", repId)
    .eq("platform", platform)
    .not("canvas_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.canvas_id as string | undefined) ?? null;
}

// After the idea is claimed, resolve one platform independently: if the rep already
// has a canvas for it, post a replace-confirm and stop; otherwise post an interim note
// and draft now. Never throws.
async function commitOnePlatform(
  ideaId: string,
  idea: Idea,
  profile: Profile,
  channel: string,
  moment: DemoMoment | null,
  platform: Platform,
): Promise<void> {
  const existing = await currentCanvasId(profile.id, platform);
  if (existing) {
    await slack.chat
      .postMessage({
        channel,
        blocks: buildReplaceConfirmBlocks(ideaId, platform, idea.hook),
        text: `You already have a ${PLATFORM_LABEL[platform]} draft — replace it?`,
      })
      .catch((e) => console.error("replace-confirm post failed", { ideaId, platform, error: e }));
    return;
  }
  const interim = await slack.chat
    .postMessage({ channel, text: `✍️ Drafting your ${PLATFORM_LABEL[platform]} draft in your voice… your canvas will appear at the top of this chat window in a few seconds.` })
    .catch(() => null);
  await draftNow(ideaId, idea, profile, channel, moment, platform, interim?.ts);
}

// Claim the idea once (claim-at-commit), then resolve each platform independently:
// existing canvas -> replace-confirm; no canvas -> draft now. Runs post-ack; never throws.
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

  // One shared moment read for all platforms.
  const meetingId =
    typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
      ? (idea.source_ref as { meetingId: string }).meetingId
      : null;
  const moment =
    idea.source === "demo" && meetingId
      ? await readDemoMoment(meetingId).catch(() => null)
      : null;

  // Each platform resolves independently (a Both draft may confirm one and draft the other).
  await Promise.all(
    platforms.map((platform) => commitOnePlatform(ideaId, idea, profile, channel, moment, platform)),
  );
}

// Draft one platform (reuse-aware) and, on failure, offer a working retry button.
// The claim is already committed at this point, so a failure keeps the idea and lets
// the rep retry rather than silently losing it. Never throws.
async function draftNow(
  ideaId: string,
  idea: Idea,
  profile: Profile,
  channel: string,
  moment: DemoMoment | null,
  platform: Platform,
  interimTs: string | undefined,
): Promise<void> {
  const result = await draftOnePlatform(idea, profile, channel, moment, platform, interimTs);
  if (result.ok) return;
  const blocks = buildRetryBlocks(ideaId, [platform], "");
  const text = `I couldn't finish the ${PLATFORM_LABEL[platform]} draft this time.`;
  try {
    if (interimTs) await slack.chat.update({ channel, ts: interimTs, text, blocks });
    else await slack.chat.postMessage({ channel, text, blocks });
  } catch (e) {
    console.error("retry-offer post failed", { ideaId, platform, error: e });
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

    // Reuse the rep's existing canvas for this platform, editing it in place. If the
    // edit fails (canvas deleted out from under us) fall back to a fresh canvas so a
    // draft never dead-ends. If there's no existing canvas, create one.
    const existingCanvasId = await currentCanvasId(profile.id, platform);
    let canvasId: string;
    if (existingCanvasId) {
      try {
        await editCanvas(existingCanvasId, body);
        canvasId = existingCanvasId;
      } catch (e) {
        console.error("editCanvas failed; creating a fresh canvas", { repId: profile.id, platform, canvasId: existingCanvasId, error: e });
        canvasId = await createCanvasInDM(channel, canvasTitle(platform, idea.hook), body);
      }
    } else {
      canvasId = await createCanvasInDM(channel, canvasTitle(platform, idea.hook), body);
    }

    const openerBlocks = buildOpenerBlocks(platform, idea.hook, { wasRedacted });
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

// Replace clicked → draft this platform now (reuse-aware: edits the existing canvas)
// without re-claiming. Reuses the confirm message as the drafting note / opener.
// Runs post-ack (inside waitUntil); must never throw.
export async function handleDraftReplaceConfirm(payload: unknown): Promise<void> {
  const c = messageCoords(payload);
  const p = payload as { actions?: { value?: unknown }[]; user?: { id?: unknown } };
  const rawValue = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  if (!c || typeof rawValue !== "string" || typeof slackUserId !== "string") return;

  const parsed = parsePlatformValue(rawValue);
  if (!parsed || parsed.selection === "both") return; // replace is single-platform only
  const platform: Platform = parsed.selection; // narrowed to "linkedin" | "instagram"

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await slack.chat.update({ channel: c.channel, ts: c.ts, text: "I couldn't find your profile yet — finish onboarding and try again.", blocks: [] }).catch(() => {});
      return;
    }
    const idea = await getIdea(parsed.ideaId, profile.id);
    if (!idea) {
      await slack.chat.update({ channel: c.channel, ts: c.ts, text: "Hmm, I couldn't find that idea — grab another from your latest digest.", blocks: [] }).catch(() => {});
      return;
    }
    // Turn the confirm message into the drafting note; draftNow reuses this ts as the opener.
    await slack.chat.update({ channel: c.channel, ts: c.ts, text: `✍️ Replacing your ${PLATFORM_LABEL[platform]} draft in your voice…`, blocks: [] }).catch(() => {});
    const meetingId =
      typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
        ? (idea.source_ref as { meetingId: string }).meetingId
        : null;
    const moment =
      idea.source === "demo" && meetingId
        ? await readDemoMoment(meetingId).catch(() => null)
        : null;
    await draftNow(parsed.ideaId, idea, profile, c.channel, moment, platform, c.ts);
  } catch (e) {
    console.error("handleDraftReplaceConfirm failed", { slackUserId, ideaId: parsed.ideaId, error: e });
  }
}

// Keep current clicked → leave the canvas untouched; the idea stays consumed.
// Runs post-ack; never throws.
export async function handleDraftReplaceCancel(payload: unknown): Promise<void> {
  const c = messageCoords(payload);
  if (!c) return;
  const p = payload as { actions?: { value?: unknown }[] };
  const rawValue = p?.actions?.[0]?.value;
  const parsed = typeof rawValue === "string" ? parsePlatformValue(rawValue) : null;
  const text =
    parsed && parsed.selection !== "both"
      ? `Kept your current ${PLATFORM_LABEL[parsed.selection]} draft 👍`
      : "Kept your current draft 👍";
  await slack.chat
    .update({ channel: c.channel, ts: c.ts, text, blocks: [] })
    .catch((e) => console.error("handleDraftReplaceCancel failed", { channel: c.channel, ts: c.ts, error: e }));
}

// channel + message ts for a button click on one of the bot's own messages.
type MessageActionPayload = {
  channel?: { id?: unknown };
  message?: { ts?: unknown };
  container?: { message_ts?: unknown };
};
function messageCoords(payload: unknown): { channel: string; ts: string } | null {
  const p = payload as MessageActionPayload;
  const channel = p?.channel?.id;
  const ts = p?.message?.ts ?? p?.container?.message_ts;
  if (typeof channel !== "string" || typeof ts !== "string") return null;
  return { channel, ts };
}
