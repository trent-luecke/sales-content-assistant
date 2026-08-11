# Single-Canvas-Per-Platform Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each rep at most one LinkedIn canvas and one Instagram canvas, reused in place across every draft, replacing the delete-based cleanup flow that leaves permanent DM tombstones.

**Architecture:** Every draft for a `(rep, platform)` reuses that platform's most-recent non-null `canvas_id`, editing the canvas via `canvases.edit` instead of creating a new one. A **replace-confirm** step guards an overwrite when a canvas already exists (per-platform and independent for "Both"). The idea is **claimed at commit** (Draft this / platform pick), before the confirms; per-platform drafts then use `getIdea` (no re-claim). The entire "Done → delete" surface is removed and ships with the new flow.

**Tech Stack:** Next.js (App Router, this repo's vendored version), TypeScript, `@slack/web-api`, Supabase (`sca_thread_map`), Vitest for pure logic.

## Global Constraints

Copied verbatim from the spec and handoff — every task's requirements implicitly include these:

- **Post-ack invariant:** every interactivity handler runs inside `waitUntil` and must NEVER throw. Handlers own all their failure handling.
- **No schema migration.** `platform` and (nullable) `canvas_id` already exist on `sca_thread_map`. Every draft still inserts a new `sca_thread_map` row — nothing is deleted (utilization-tracker data must survive).
- **No delete-based approach anywhere.** `canvases.delete` and `files.delete` both leave an unremovable "deleted by owner" tombstone. Reuse-in-place is the only mechanism.
- **Anonymization guardrail in `generateDraft` is unchanged.** The AI never publishes; the rep is the author.
- **Claim-at-commit, accepted consequence:** committing then Keeping every existing draft still consumes the idea. This is deliberate (avoids a race across two async platform drafts).
- **Testing split (repo convention):** pure logic in `lib/digest.ts` is unit-tested with Vitest (`npm test`). Slack/RAG/AI I/O and thin DB wrappers (`lib/draft.ts`, `lib/slack/canvas.ts`) are NOT unit-tested — verified by `npx tsc --noEmit` + a live Vercel pass. TDD (failing test first) applies only to the pure builders.
- **Typecheck gate:** `npx tsc --noEmit`. There is no `noUnusedLocals`, so dead imports/functions pass tsc silently — remove them by hand.
- **Slack action_id rules:** every button in one actions block needs a unique `action_id`. `draft_replace_confirm` and `draft_replace_cancel` are distinct strings where neither prefixes the other, so the route matches them by **exact** equality.
- **Commit directly to `main`.** Stage only the specific files per task (`git add <paths>`, then confirm with `git diff --cached --name-only`) — never `git add -A`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/digest.ts` | Pure Block Kit builders + action constants + value encoding | Add `DRAFT_REPLACE_*` constants + `buildReplaceConfirmBlocks`; later slim `buildOpenerBlocks` and remove `buildDoneConfirmBlocks` + `DRAFT_DONE_*` |
| `lib/__tests__/digest.test.ts` | Unit tests for the pure builders | Add `buildReplaceConfirmBlocks` tests; later delete `buildDoneConfirmBlocks` tests + rewrite `buildOpenerBlocks` tests |
| `lib/draft.ts` | Interactivity handlers + reuse-aware drafting (I/O; not unit-tested) | Add `currentCanvasId`, make `draftOnePlatform` reuse-aware, branch `claimAndDraft` into confirm-or-draft, add `handleDraftReplaceConfirm/Cancel`; later remove the `handleDraftDone*` surface |
| `lib/slack/canvas.ts` | Thin Slack canvas wrappers (I/O; not unit-tested) | Later remove `deleteCanvas` |
| `app/api/slack/interactivity/route.ts` | Routes block-action `action_id`s to handlers | Swap the three `draft_done*` branches for two `draft_replace_*` branches |

**Task sequencing rationale (read before reordering):** `tsc` is whole-project and there is no `noUnusedLocals`. The removals are ordered so **every commit is tsc-green**:
- Tasks 1–2 are additive (new constants, new builder, new handlers) — nothing removed, so nothing breaks.
- Task 3 stops the route from importing the Done symbols; after it, `handleDraftDone*` are merely unreferenced (still compile).
- Task 4 removes the Done/delete surface **and** slims `buildOpenerBlocks` in one atomic commit. This is forced: `buildOpenerBlocks` is called by both `draftOnePlatform` (kept) and `handleDraftDoneCancel` (removed), and `deleteCanvas` is called by `handleDraftDoneConfirm` (removed) — so the signature change and the deletions cannot be split without a red intermediate `tsc`.

---

## Task 1: Add the replace-confirm builder to `lib/digest.ts` (pure, TDD)

Purely additive. New constants + one new builder + its tests. Nothing else in `digest.ts` changes yet.

**Files:**
- Modify: `lib/digest.ts` (add near the other action constants and builders)
- Test: `lib/__tests__/digest.test.ts` (add a new `describe` block + imports)

**Interfaces:**
- Consumes: `encodePlatformValue(ideaId, selection)`, `PLATFORM_LABEL`, `Platform`, `KnownBlock` (all already in `lib/digest.ts` / its imports).
- Produces (later tasks rely on these exact names):
  - `export const DRAFT_REPLACE_CONFIRM_ACTION = "draft_replace_confirm"`
  - `export const DRAFT_REPLACE_CANCEL_ACTION = "draft_replace_cancel"`
  - `export function buildReplaceConfirmBlocks(ideaId: string, platform: Platform, hook: string): KnownBlock[]`

- [ ] **Step 1: Write the failing tests**

Add these imports to the existing import block at the top of `lib/__tests__/digest.test.ts` (alongside the current named imports from `@/lib/digest`):

```ts
  buildReplaceConfirmBlocks,
  DRAFT_REPLACE_CONFIRM_ACTION,
  DRAFT_REPLACE_CANCEL_ACTION,
```

Append this `describe` block to the end of `lib/__tests__/digest.test.ts`:

```ts
describe("buildReplaceConfirmBlocks", () => {
  it("names the platform, references the new hook, and offers two uniquely-identified buttons", () => {
    const blocks = buildReplaceConfirmBlocks("idea-5", "linkedin", "How a demo lands");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn");
    expect(json).toContain("How a demo lands");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toEqual([DRAFT_REPLACE_CONFIRM_ACTION, DRAFT_REPLACE_CANCEL_ACTION]);
    expect(new Set(ids).size).toBe(2); // unique action_ids
  });

  it("encodes <ideaId>|<platform> on both buttons and round-trips via parsePlatformValue", () => {
    const blocks = buildReplaceConfirmBlocks("idea-5", "instagram", "hook");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { value: string }[] };
    for (const el of actions.elements) {
      expect(el.value).toBe("idea-5|instagram");
      expect(parsePlatformValue(el.value)).toEqual({ ideaId: "idea-5", selection: "instagram" });
    }
  });

  it("neither action_id prefixes the other (safe for exact-match routing)", () => {
    expect(DRAFT_REPLACE_CONFIRM_ACTION.startsWith(DRAFT_REPLACE_CANCEL_ACTION)).toBe(false);
    expect(DRAFT_REPLACE_CANCEL_ACTION.startsWith(DRAFT_REPLACE_CONFIRM_ACTION)).toBe(false);
  });
});
```

(`parsePlatformValue` is already imported in this test file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- digest`
Expected: FAIL — `buildReplaceConfirmBlocks` / `DRAFT_REPLACE_CONFIRM_ACTION` / `DRAFT_REPLACE_CANCEL_ACTION` are not exported (import error / "is not a function").

- [ ] **Step 3: Write the minimal implementation**

In `lib/digest.ts`, add the two constants immediately after the existing `DRAFT_DONE_*` constants (around line 42):

```ts
export const DRAFT_REPLACE_CONFIRM_ACTION = "draft_replace_confirm";
export const DRAFT_REPLACE_CANCEL_ACTION = "draft_replace_cancel";
```

Add this builder to `lib/digest.ts` (place it just above `buildOpenerBlocks`):

```ts
// The replace-confirm prompt shown when a rep drafts a new idea for a platform that
// already has a canvas. Two uniquely-identified buttons, both carrying the
// "<ideaId>|<platform>" value so the confirm/cancel handlers know what to draft.
export function buildReplaceConfirmBlocks(
  ideaId: string,
  platform: Platform,
  hook: string,
): KnownBlock[] {
  const value = encodePlatformValue(ideaId, platform);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `You have a current *${PLATFORM_LABEL[platform]}* draft in its canvas. ` +
          `Replace it with a new draft for *${hook}*?`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Replace" },
          action_id: DRAFT_REPLACE_CONFIRM_ACTION,
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Keep current" },
          action_id: DRAFT_REPLACE_CANCEL_ACTION,
          value,
        },
      ],
    },
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- digest`
Expected: PASS (all `buildReplaceConfirmBlocks` tests green; the pre-existing digest tests still green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add lib/digest.ts lib/__tests__/digest.test.ts
git diff --cached --name-only
git commit -m "feat(sca): add buildReplaceConfirmBlocks + draft_replace action constants"
```

---

## Task 2: Reuse-aware drafting, claim-at-commit branching, and replace handlers in `lib/draft.ts`

Additive to the handler layer: the canvas is now reused/edited in place, drafting branches into a replace-confirm when a canvas already exists, and two new handlers resolve the confirm. The old `handleDraftDone*` handlers are **left intact** so the route still compiles (they are removed in Task 4). Not unit-tested (Slack/DB I/O) — verified by `tsc`.

**Files:**
- Modify: `lib/draft.ts`

**Interfaces:**
- Consumes: `buildReplaceConfirmBlocks`, `DRAFT_REPLACE_*` (Task 1); `editCanvas`, `createCanvasInDM` (`lib/slack/canvas.ts`); `claimIdea`, `getIdea` (`lib/ideas.ts`); `parsePlatformValue`, `platformsForSelection`, `buildRetryBlocks`, `buildOpenerBlocks` (`lib/digest.ts`); `PLATFORM_LABEL`, `canvasTitle`, `generateDraft` (`lib/generation.ts`).
- Produces (Task 3 imports these exact names):
  - `export async function handleDraftReplaceConfirm(payload: unknown): Promise<void>`
  - `export async function handleDraftReplaceCancel(payload: unknown): Promise<void>`

- [ ] **Step 1: Update imports**

In `lib/draft.ts`, change the ideas import (line 3) to drop `setIdeaStatus` (its only use is removed in this task):

```ts
import { claimIdea, getIdea } from "@/lib/ideas";
```

Add `buildReplaceConfirmBlocks` to the `@/lib/digest` import block (keep `buildDoneConfirmBlocks` — Task 4 removes it):

```ts
import {
  parsePlatformValue,
  platformsForSelection,
  buildPlatformChoiceBlocks,
  buildRetryBlocks,
  buildOpenerBlocks,
  buildReplaceConfirmBlocks,
  buildDoneConfirmBlocks,
} from "@/lib/digest";
```

Add `editCanvas` to the canvas import (line 17; keep `deleteCanvas` — Task 4 removes it):

```ts
import { createCanvasInDM, editCanvas, deleteCanvas } from "@/lib/slack/canvas";
```

- [ ] **Step 2: Add the `currentCanvasId` lookup**

Add this helper to `lib/draft.ts`, next to the other DB helpers (e.g. just after `threadTsForIdeaPlatform`, ~line 104):

```ts
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
```

- [ ] **Step 3: (No new coords helper — reuse `cleanupCoords`)**

The replace handlers need the channel + message ts of a button click, which the
existing `cleanupCoords` (currently ~line 336) already returns. **Do not add a
second helper** — the replace handlers in Steps 8-9 call `cleanupCoords` directly
(function declarations hoist, so calling it above its definition is fine). Task 4
renames `cleanupCoords` → `messageCoords` once the Done handlers that share the
name's "cleanup" meaning are gone. Nothing to write in this step; it exists so the
naming decision is explicit before Steps 8-9 use it.

- [ ] **Step 4: Make `draftOnePlatform` reuse-aware**

Replace the entire body of `draftOnePlatform` (currently ~lines 181-218) with this. The only changes are the canvas resolution block (reuse-and-edit with a create fallback) and that `buildOpenerBlocks` is still called with the **current** 4-arg signature (`canvasId` stays until Task 4 slims it):

```ts
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
```

- [ ] **Step 5: Add the `draftNow` helper**

Add this to `lib/draft.ts` (place it just above `draftOnePlatform`). It drafts one platform and, on failure, offers a working per-platform retry — the claim is already committed, so a failure keeps the idea rather than releasing it:

```ts
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
```

- [ ] **Step 6: Add the `commitOnePlatform` helper**

Add this to `lib/draft.ts` (just above `claimAndDraft`, ~line 109). It decides one platform's fate after the idea is claimed — replace-confirm if a canvas exists, draft-now otherwise:

```ts
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
```

- [ ] **Step 7: Rewrite `claimAndDraft` to branch per platform**

Replace the entire body of `claimAndDraft` (currently ~lines 109-179) with this. It keeps the claim-outcome handling and the single shared moment read, then hands each platform to `commitOnePlatform`. The old shared-interim + combined partial-failure block is gone (per-platform independence lives in `commitOnePlatform`/`draftNow` now):

```ts
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
```

- [ ] **Step 8: Add `handleDraftReplaceConfirm`**

Add this exported handler to `lib/draft.ts` (place it after `handleDraftRetry`, ~line 328). It re-drafts one platform of an already-`used` idea without re-claiming, reusing the confirm message as the drafting note → opener:

```ts
// Replace clicked → draft this platform now (reuse-aware: edits the existing canvas)
// without re-claiming. Reuses the confirm message as the drafting note / opener.
// Runs post-ack (inside waitUntil); must never throw.
export async function handleDraftReplaceConfirm(payload: unknown): Promise<void> {
  const c = cleanupCoords(payload);
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
```

- [ ] **Step 9: Add `handleDraftReplaceCancel`**

Add this exported handler directly below `handleDraftReplaceConfirm`:

```ts
// Keep current clicked → leave the canvas untouched; the idea stays consumed.
// Runs post-ack; never throws.
export async function handleDraftReplaceCancel(payload: unknown): Promise<void> {
  const c = cleanupCoords(payload);
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
```

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). If tsc reports `buildDoneConfirmBlocks`/`deleteCanvas` as errors, they were removed prematurely — they must stay until Task 4.

- [ ] **Step 11: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS — the same green suite as before plus Task 1's new tests. (No new unit tests here; `draft.ts` is I/O, verified by tsc + live.)

- [ ] **Step 12: Commit**

```bash
git add lib/draft.ts
git diff --cached --name-only
git commit -m "feat(sca): reuse-aware drafting, claim-at-commit branching, replace-confirm handlers"
```

---

## Task 3: Route `draft_replace_*` to the new handlers in `app/api/slack/interactivity/route.ts`

Swap the three `draft_done*` exact-match branches for two `draft_replace_*` exact-match branches. After this commit the route no longer references the Done symbols; `handleDraftDone*` remain defined in `draft.ts` (unreferenced but compiling) until Task 4.

**Files:**
- Modify: `app/api/slack/interactivity/route.ts`

**Interfaces:**
- Consumes: `handleDraftReplaceConfirm`, `handleDraftReplaceCancel` (Task 2); `DRAFT_REPLACE_CONFIRM_ACTION`, `DRAFT_REPLACE_CANCEL_ACTION` (Task 1).

- [ ] **Step 1: Update the handler import (line 3)**

```ts
import { handleDraftThis, handleDraftPlatform, handleDraftRetry, handleDraftReplaceConfirm, handleDraftReplaceCancel } from "@/lib/draft";
```

- [ ] **Step 2: Update the constants import (line 4)**

```ts
import { DRAFT_THIS_ACTION, DRAFT_PLATFORM_ACTION, DRAFT_RETRY_ACTION, DRAFT_REPLACE_CONFIRM_ACTION, DRAFT_REPLACE_CANCEL_ACTION } from "@/lib/digest";
```

- [ ] **Step 3: Swap the dispatch branches**

Replace the three `draft_done*` branches (currently lines 37-43) with:

```ts
    } else if (actionId === DRAFT_REPLACE_CONFIRM_ACTION) {
      waitUntil(handleDraftReplaceConfirm(payload));
    } else if (actionId === DRAFT_REPLACE_CANCEL_ACTION) {
      waitUntil(handleDraftReplaceCancel(payload));
    }
```

The surrounding branches are unchanged: `draft_this` stays exact-match; `draft_platform` and `draft_retry` keep `startsWith`. `maxDuration = 120` is unchanged.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add app/api/slack/interactivity/route.ts
git diff --cached --name-only
git commit -m "feat(sca): route draft_replace_confirm/cancel; drop draft_done branches"
```

---

## Task 4: Remove the Done/delete surface and slim `buildOpenerBlocks` (atomic)

One atomic commit across three source files + the digest test file. This is where the slimmed `buildOpenerBlocks` signature lands, so its only caller (`draftOnePlatform`) and its now-removed caller (`handleDraftDoneCancel`) must change in the same commit — splitting this yields a red intermediate `tsc`.

**Files:**
- Modify: `lib/digest.ts` (remove `buildDoneConfirmBlocks` + `DRAFT_DONE_*`; slim `buildOpenerBlocks`)
- Modify: `lib/draft.ts` (remove the `handleDraftDone*` surface + its private helpers + dead imports; update the `buildOpenerBlocks` call)
- Modify: `lib/slack/canvas.ts` (remove `deleteCanvas`)
- Modify: `lib/__tests__/digest.test.ts` (delete `buildDoneConfirmBlocks` tests + imports; rewrite `buildOpenerBlocks` tests)

**Interfaces:**
- Produces the slimmed signature every caller must match:
  - `export function buildOpenerBlocks(platform: Platform, hook: string, opts?: { wasRedacted?: boolean }): KnownBlock[]`

- [ ] **Step 1: Rewrite the `buildOpenerBlocks` unit tests (failing first)**

In `lib/__tests__/digest.test.ts`, remove these three names from the `@/lib/digest` import block: `buildDoneConfirmBlocks`, `DRAFT_DONE_ACTION`, `DRAFT_DONE_CONFIRM_ACTION`, `DRAFT_DONE_CANCEL_ACTION`.

Replace the entire `describe("buildOpenerBlocks", ...)` block (currently lines 263-285) with:

```ts
describe("buildOpenerBlocks", () => {
  it("names the platform and the canvas, with no buttons", () => {
    const blocks = buildOpenerBlocks("linkedin", "How a demo lands");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn draft");
    expect(json).toContain("LI: How a demo lands"); // canvasTitle output
    expect(blocks.some((b) => b.type === "actions")).toBe(false); // Done button gone
  });
  it("uses IG labeling for instagram", () => {
    const json = JSON.stringify(buildOpenerBlocks("instagram", "A tight hook"));
    expect(json).toContain("Instagram draft");
    expect(json).toContain("IG: A tight hook");
  });
  it("appends the redaction caveat only when wasRedacted", () => {
    const withNote = JSON.stringify(buildOpenerBlocks("linkedin", "h", { wasRedacted: true }));
    const without = JSON.stringify(buildOpenerBlocks("linkedin", "h"));
    expect(withNote).toContain("redact");
    expect(without).not.toContain("redact");
  });
});
```

Delete the entire `describe("buildDoneConfirmBlocks", ...)` block (currently lines 287-298).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- digest`
Expected: FAIL — `buildOpenerBlocks` still requires the `canvasId` arg / still emits an actions block, so the new no-button test and the 2-arg calls fail (type or assertion errors).

- [ ] **Step 3: Slim `buildOpenerBlocks` in `lib/digest.ts`**

Replace the entire current `buildOpenerBlocks` (currently lines 188-220) with:

```ts
// The draft's opener message: platform-labeled, names its canvas, no buttons. A new
// opener (its own thread) is posted per draft while the canvas itself is reused.
export function buildOpenerBlocks(
  platform: Platform,
  hook: string,
  opts?: { wasRedacted?: boolean },
): KnownBlock[] {
  const caveat = opts?.wasRedacted ? REDACTED_NOTE : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${PLATFORM_LABEL[platform]} draft* — your latest cut is in the canvas ` +
          `*${canvasTitle(platform, hook)}* above. Reply in a thread to tell me what to change.${caveat}`,
      },
    },
  ];
}
```

- [ ] **Step 4: Remove `buildDoneConfirmBlocks` and the `DRAFT_DONE_*` constants from `lib/digest.ts`**

Delete the three constants (currently lines 40-42):

```ts
export const DRAFT_DONE_ACTION = "draft_done";
export const DRAFT_DONE_CONFIRM_ACTION = "draft_done_confirm";
export const DRAFT_DONE_CANCEL_ACTION = "draft_done_cancel";
```

Delete the entire `buildDoneConfirmBlocks` function (currently lines 222-255, the block starting `// The confirm prompt (state 2): ...` through its closing `}`).

- [ ] **Step 5: Remove `deleteCanvas` from `lib/slack/canvas.ts`**

Delete the entire `deleteCanvas` function and its comment (currently lines 30-36, from `// Delete a bot-owned Canvas ...` through the closing `}`). `createCanvasInDM` and `editCanvas` remain.

- [ ] **Step 6: Update the `buildOpenerBlocks` call in `lib/draft.ts`**

In `draftOnePlatform`, change the opener line to the slimmed 2-arg + opts signature:

```ts
    const openerBlocks = buildOpenerBlocks(platform, idea.hook, { wasRedacted });
```

- [ ] **Step 7: Remove the dead imports in `lib/draft.ts`**

Drop `buildDoneConfirmBlocks` from the `@/lib/digest` import block:

```ts
import {
  parsePlatformValue,
  platformsForSelection,
  buildPlatformChoiceBlocks,
  buildRetryBlocks,
  buildOpenerBlocks,
  buildReplaceConfirmBlocks,
} from "@/lib/digest";
```

Drop `deleteCanvas` from the canvas import (line 17):

```ts
import { createCanvasInDM, editCanvas } from "@/lib/slack/canvas";
```

- [ ] **Step 8: Remove the Done handlers and their now-orphaned private helpers from `lib/draft.ts`**

Delete the following (everything from `handleDraftDone` through the end of `handleDraftDoneCancel`, currently ~lines 344-420, plus the two helpers only they used):

- `threadMapByThreadTs` (only the Done handlers used it)
- `hookForRow` (only the Done handlers used it)
- `handleDraftDone`
- `handleDraftDoneConfirm`
- `handleDraftDoneCancel`

**Keep** `cleanupCoords` + its `CleanupPayload` type (the replace handlers use them now), but **rename** them for accuracy since "cleanup" no longer fits:

```ts
type MessageActionPayload = {
  channel?: { id?: unknown };
  message?: { ts?: unknown };
  container?: { message_ts?: unknown };
};
// channel + message ts for a button click on one of the bot's own messages.
function messageCoords(payload: unknown): { channel: string; ts: string } | null {
  const p = payload as MessageActionPayload;
  const channel = p?.channel?.id;
  const ts = p?.message?.ts ?? p?.container?.message_ts;
  if (typeof channel !== "string" || typeof ts !== "string") return null;
  return { channel, ts };
}
```

Then update the two call sites in `handleDraftReplaceConfirm` and `handleDraftReplaceCancel` from `cleanupCoords(payload)` to `messageCoords(payload)`.

Keep `threadTsForIdea`, `threadTsForIdeaPlatform`, `safePost`, `updateOrPost`, and every other helper.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). A `Cannot find name` / `is declared but never used`-style error here means a helper was removed that something still calls, or a call site still uses the old signature — fix before proceeding.

- [ ] **Step 10: Run the full unit suite**

Run: `npm test`
Expected: PASS — the whole suite green, including the rewritten `buildOpenerBlocks` tests, and no test references `buildDoneConfirmBlocks` or `DRAFT_DONE_*`.

- [ ] **Step 11: Grep for any surviving references (must be empty)**

Run:
```bash
grep -rn "DRAFT_DONE\|buildDoneConfirmBlocks\|deleteCanvas\|handleDraftDone\|cleanupCoords\|threadMapByThreadTs\|hookForRow" --include="*.ts" --include="*.tsx" . | grep -v node_modules
```
Expected: no output. Any hit is a missed removal.

- [ ] **Step 12: Commit**

```bash
git add lib/digest.ts lib/draft.ts lib/slack/canvas.ts lib/__tests__/digest.test.ts
git diff --cached --name-only
git commit -m "refactor(sca): remove Done/delete surface; slim opener to no-button"
```

---

## Task 5: Live verification (Trent hand-off)

Not an automated task — this is the real proof, per the handoff. It matters more than usual here because this removes shipped live code **and** rewrites the core draft path. **The implementer stops before this and hands off to Trent** (deploy + Slack click-through). Deploy per the `sca-deployment-model` auto-memory.

**Files:** none (deploy + manual Slack verification).

- [ ] **Step 1: Pre-flight — clean tree, green checks**

Run:
```bash
git status
npx tsc --noEmit
npm test
```
Expected: clean working tree, tsc exit 0, all tests green.

- [ ] **Step 2: Deploy to prod, then sync the git remote**

Deploy the local working tree, then push so the GitHub remote can't serve stale code (the stale-remote incident in the `sca-deployment-model` memory):

```bash
vercel --prod --yes
git push origin main
```
Expected: a successful prod deployment; `main` pushed and even with origin.

- [ ] **Step 3: Fire a digest to surface "Draft this"**

Trigger a digest (the weekly cron from step 8 is not built) via the internal endpoint, authenticating with the sensitive `SCA_INTERNAL_KEY` (Trent holds the value):

```bash
curl -X POST https://sales-content-assistant.vercel.app/api/digest/generate -H "Authorization: Bearer $SCA_INTERNAL_KEY"
```
Expected: a fresh digest DM with "Draft this" buttons. (If the pool is empty, refill first: `curl -X POST https://sales-content-assistant.vercel.app/api/pool/refill -H "Authorization: Bearer $SCA_INTERNAL_KEY"`.)

- [ ] **Step 4: Verify single-canvas reuse (the core proof)**

In the rep ↔ bot DM:
1. Draft a LinkedIn idea → confirm **exactly one** LinkedIn canvas is created, no tombstone.
2. Draft another LinkedIn idea → a **replace-confirm** appears → click **Replace** → the **same** canvas updates in place. No new canvas, no stub.
3. Repeat across several drafts → the LinkedIn canvas count stays at **exactly one**, and no "deleted by owner" stubs ever appear at the top of the DM.

Expected: one LinkedIn canvas throughout; content reflects the latest draft; zero accumulation.

- [ ] **Step 5: Verify "Keep current"**

Draft a second LinkedIn idea → on the replace-confirm click **Keep current**.
Expected: the message updates to "Kept your current LinkedIn draft 👍"; the canvas is untouched; the idea is consumed (won't resurface in a later digest).

- [ ] **Step 6: Verify "Both" mixed state (independent per-platform outcomes)**

As a both-channel rep with a LinkedIn canvas already present but no Instagram canvas: click **Draft this** → **Both**.
Expected: the Instagram side drafts immediately (creates its one canvas); the LinkedIn side shows a replace-confirm. Resolving one does not affect the other.

- [ ] **Step 7: Confirm no accumulation and report**

Scroll the top of the DM.
Expected: at most one LinkedIn + one Instagram canvas, and **no** "deleted by owner" tombstones anywhere. Report the outcome (and update `.superpowers/sdd/progress.md`).

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Reuse one canvas per `(rep, platform)`; first draft creates, later drafts `canvases.edit` → Task 2 (`currentCanvasId` + reuse-aware `draftOnePlatform`). ✅
- Replace-confirm before overwrite, per-platform for Both → Task 1 (`buildReplaceConfirmBlocks`) + Task 2 (`commitOnePlatform`, `handleDraftReplaceConfirm/Cancel`). ✅
- Claim-at-commit; per-platform drafts use `getIdea` (no re-claim) → Task 2 (`claimAndDraft` claims once; `handleDraftReplaceConfirm` uses `getIdea`). ✅
- Removal of the delete-based cleanup flow → Task 4 (all Done/delete symbols + tests). ✅
- Slim opener to platform-labeled text without a Done button → Task 4 (`buildOpenerBlocks`). ✅
- Reuse-edit-fail → create fallback (risk) → Task 2 (`draftOnePlatform` try/catch around `editCanvas`). ✅
- Route: drop `draft_done*`, add `draft_replace_*` exact-match → Task 3. ✅
- Testing: `buildReplaceConfirmBlocks` (unique ids, encoded values), slimmed `buildOpenerBlocks` (no actions block), removed builders' tests deleted → Tasks 1 & 4. ✅
- Live verification (reuse, Keep, Both-mixed, no stubs) → Task 5. ✅

**2. Placeholder scan:** No "TBD"/"handle appropriately"/"similar to Task N"/"write tests for the above" — every code and test step carries complete code. ✅

**3. Type consistency:**
- `buildReplaceConfirmBlocks(ideaId, platform, hook)` — defined Task 1, called Task 2 (`commitOnePlatform`) with matching args. ✅
- `handleDraftReplaceConfirm` / `handleDraftReplaceCancel` — defined Task 2, imported/dispatched Task 3 by the exact names. ✅
- `buildOpenerBlocks` — 4-arg (`platform, hook, canvasId, opts`) in Task 2's `draftOnePlatform`; slimmed to 3-arg (`platform, hook, opts`) in Task 4 with the single caller updated in the same commit (no red intermediate). ✅
- `currentCanvasId(repId, platform) → Promise<string | null>` — one definition (Task 2), used by `draftOnePlatform` and `commitOnePlatform`. ✅
- `draftNow(ideaId, idea, profile, channel, moment, platform, interimTs)` — one signature, called by `commitOnePlatform` and `handleDraftReplaceConfirm` with matching args. ✅
- `setIdeaStatus` import dropped in Task 2 (its only use removed); `deleteCanvas`/`buildDoneConfirmBlocks` imports dropped in Task 4 with their last uses. ✅

**Deliberate behavior change to flag at review:** the old single-channel "release the claim on total draft failure" (`setIdeaStatus(ideaId, "candidate")`) is replaced by "keep the claim, offer a per-platform retry button" (`draftNow` → `buildRetryBlocks`) — consistent with the existing `handleDraftRetry` UX and with claim-at-commit. Called out here so the reviewer signs off intentionally.
