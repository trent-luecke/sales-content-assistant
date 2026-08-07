# Draft Canvas Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each draft a self-describing, platform-labeled opener with a manual two-step "Done" button that deletes that platform's canvas (keeping the DB row for the utilization tracker).

**Architecture:** Pure Block Kit builders (`buildOpenerBlocks`, `buildDoneConfirmBlocks`) in `lib/digest.ts` render the three opener states; `draftOnePlatform` posts the opener as blocks instead of plain text; three new post-ack handlers in `lib/draft.ts` (`handleDraftDone`/`Confirm`/`Cancel`) drive the state machine, deleting the canvas via a new `deleteCanvas` helper and nulling `sca_thread_map.canvas_id` (no migration); the interactivity route dispatches the three new actions by exact match.

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, `@slack/web-api`, Supabase, Vitest.

## Global Constraints

- **Spec:** [2026-08-07-canvas-cleanup-design.md](../specs/2026-08-07-canvas-cleanup-design.md). Every task's requirements include this section.
- **No schema migration.** Cleanup sets `sca_thread_map.canvas_id = null` (column already nullable). Never delete the row — it is the utilization tracker's record. Nulled `canvas_id` = cleaned-marker + idempotency guard.
- **Post-ack invariant:** `handleDraftDone`, `handleDraftDoneConfirm`, `handleDraftDoneCancel` run inside `waitUntil` and MUST NEVER throw.
- **Two-step confirm.** Canvas deletion is irreversible: `Done` → confirm prompt; only `Yes, delete` calls `deleteCanvas`.
- **State never lies:** on `deleteCanvas` failure, do NOT null the row or show "Cleared" — leave the confirm message intact and post a soft retry note.
- **Unique `action_id` per button** (Slack rejects duplicate action_ids within one actions block — this bit us before). The two confirm buttons must differ.
- **Exact-match routing for the done-family:** `"draft_done"` is a prefix of `"draft_done_confirm"`/`"draft_done_cancel"`, so the route MUST use exact equality for these three (not `startsWith`). `draft_this` stays exact; `draft_platform`/`draft_retry` keep `startsWith`.
- **Platform values lowercase** `"linkedin"|"instagram"`; labels `LinkedIn`/`Instagram` (via `PLATFORM_LABEL`); canvas-title tags `LI:`/`IG:` (via `canvasTitle`), both exported from `lib/generation.ts`.
- **`canvases:write` scope** already granted (step 6); `canvases.delete` reuse verified in the live pass.
- **Test command:** `npm test` (`vitest run`). **Typecheck:** `npx tsc --noEmit`. Both green before each commit. `lib/draft.ts` and `lib/slack/canvas.ts` I/O are NOT unit-tested (repo convention) — verified by tsc + live pass; only the pure `lib/digest.ts` builders get unit tests.
- **Staging:** own git repo; stage only the named files per task (never `git add -A`; confirm `git diff --cached --name-only`). Commit to `main`.
- **Deploy model (from the 2026-08-07 incident):** ship via `vercel --prod` CLI, then `git push origin main` to keep the remote synced (a Git-integration build of a stale remote previously broke prod). Deploy happens in the live-verification task, not per code task.

---

## File Structure

- `lib/digest.ts` — add `DRAFT_DONE_ACTION`/`DRAFT_DONE_CONFIRM_ACTION`/`DRAFT_DONE_CANCEL_ACTION`, `buildOpenerBlocks`, `buildDoneConfirmBlocks`, and the moved `REDACTED_NOTE` caveat text. (Home of the Block Kit builders.)
- `lib/slack/canvas.ts` — add `deleteCanvas`.
- `lib/draft.ts` — `draftOnePlatform` posts `buildOpenerBlocks`; add `threadMapByThreadTs` lookup + the three handlers; drop the now-unused `OPENER`/`REDACTED_NOTE` constants.
- `app/api/slack/interactivity/route.ts` — dispatch the three new actions (exact match).
- Test: `lib/__tests__/digest.test.ts` (extend).

---

## Task 1: digest.ts — opener + confirm block builders

**Files:**
- Modify: `lib/digest.ts`
- Test: `lib/__tests__/digest.test.ts`

**Interfaces:**
- Consumes: `Platform`, `PLATFORM_LABEL`, `canvasTitle` from `@/lib/generation`; `KnownBlock` from `@slack/web-api`.
- Produces:
  - `export const DRAFT_DONE_ACTION = "draft_done";`
  - `export const DRAFT_DONE_CONFIRM_ACTION = "draft_done_confirm";`
  - `export const DRAFT_DONE_CANCEL_ACTION = "draft_done_cancel";`
  - `export const REDACTED_NOTE: string` (moved from draft.ts)
  - `export function buildOpenerBlocks(platform: Platform, hook: string, canvasId: string, opts?: { wasRedacted?: boolean }): KnownBlock[]`
  - `export function buildDoneConfirmBlocks(platform: Platform, hook: string, canvasId: string): KnownBlock[]`

- [ ] **Step 1: Write the failing tests**

Add `buildOpenerBlocks`, `buildDoneConfirmBlocks`, `DRAFT_DONE_ACTION`, `DRAFT_DONE_CONFIRM_ACTION`, `DRAFT_DONE_CANCEL_ACTION` to the existing import from `@/lib/digest` in `lib/__tests__/digest.test.ts`, then add:

```typescript
describe("buildOpenerBlocks", () => {
  it("names the platform and the canvas, and carries one Done button", () => {
    const blocks = buildOpenerBlocks("linkedin", "How a demo lands", "cv-1");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn draft");
    expect(json).toContain("LI: How a demo lands"); // canvasTitle output
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].action_id).toBe(DRAFT_DONE_ACTION);
    expect(actions.elements[0].value).toBe("cv-1");
  });
  it("uses IG labeling for instagram", () => {
    const json = JSON.stringify(buildOpenerBlocks("instagram", "A tight hook", "cv-2"));
    expect(json).toContain("Instagram draft");
    expect(json).toContain("IG: A tight hook");
  });
  it("appends the redaction caveat only when wasRedacted", () => {
    const withNote = JSON.stringify(buildOpenerBlocks("linkedin", "h", "cv", { wasRedacted: true }));
    const without = JSON.stringify(buildOpenerBlocks("linkedin", "h", "cv"));
    expect(withNote).toContain("redact");
    expect(without).not.toContain("redact");
  });
});

describe("buildDoneConfirmBlocks", () => {
  it("asks to confirm and offers two uniquely-identified buttons", () => {
    const blocks = buildDoneConfirmBlocks("linkedin", "How a demo lands", "cv-1");
    const json = JSON.stringify(blocks);
    expect(json.toLowerCase()).toContain("can't be undone");
    expect(json).toContain("LI: How a demo lands");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toEqual([DRAFT_DONE_CONFIRM_ACTION, DRAFT_DONE_CANCEL_ACTION]);
    expect(new Set(ids).size).toBe(2); // unique action_ids
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- digest`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `lib/digest.ts`**

Extend the generation import (it already imports `PLATFORM_LABEL`) to also bring in `canvasTitle`:
```typescript
import { PLATFORM_LABEL, canvasTitle } from "@/lib/generation";
```
Add near the other action constants:
```typescript
export const DRAFT_DONE_ACTION = "draft_done";
export const DRAFT_DONE_CONFIRM_ACTION = "draft_done_confirm";
export const DRAFT_DONE_CANCEL_ACTION = "draft_done_cancel";

// The one-time heads-up appended to an opener when a name had to be redacted.
export const REDACTED_NOTE =
  "\n\n⚠️ Heads up — I had to redact a name to keep this anonymous, so one phrase might " +
  "read a little awkwardly. Worth a quick look before you post.";

// The draft's opener message (state 1): platform-labeled, names its canvas, and carries the
// Done button. Posted by draftOnePlatform and reverted-to by the Cancel handler.
export function buildOpenerBlocks(
  platform: Platform,
  hook: string,
  canvasId: string,
  opts?: { wasRedacted?: boolean },
): KnownBlock[] {
  const caveat = opts?.wasRedacted ? REDACTED_NOTE : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${PLATFORM_LABEL[platform]} draft* — your first cut is in the canvas ` +
          `*${canvasTitle(platform, hook)}* above. Reply in a thread to tell me what to change. ` +
          `When you've posted it, hit *Done* and I'll clear the canvas.${caveat}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✓ Done — clear this draft" },
          action_id: DRAFT_DONE_ACTION,
          value: canvasId,
        },
      ],
    },
  ];
}

// The confirm prompt (state 2): two uniquely-identified buttons.
export function buildDoneConfirmBlocks(
  platform: Platform,
  hook: string,
  canvasId: string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Delete the *${canvasTitle(platform, hook)}* canvas? This can't be undone.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Yes, delete" },
          action_id: DRAFT_DONE_CONFIRM_ACTION,
          value: canvasId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Keep" },
          action_id: DRAFT_DONE_CANCEL_ACTION,
          value: canvasId,
        },
      ],
    },
  ];
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- digest`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/digest.ts lib/__tests__/digest.test.ts
git commit -m "feat(sca): opener + done-confirm Block Kit builders for canvas cleanup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: canvas.ts — deleteCanvas helper

**Files:**
- Modify: `lib/slack/canvas.ts`

**Interfaces:**
- Produces: `export async function deleteCanvas(canvasId: string): Promise<void>`

No unit test (thin Slack I/O wrapper, matching `createCanvasInDM`/`editCanvas`). Verified by tsc + the live pass.

- [ ] **Step 1: Implement**

Add to `lib/slack/canvas.ts`:
```typescript
// Delete a bot-owned Canvas (used by the cleanup "Done" flow). Throws on API error so the
// caller can keep the sca_thread_map row and the opener message honest about what happened.
export async function deleteCanvas(canvasId: string): Promise<void> {
  await slack.canvases.delete({ canvas_id: canvasId });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (If `slack.canvases.delete` is not on the installed `@slack/web-api` types, STOP and report — the scope/method needs checking before proceeding.)

- [ ] **Step 3: Commit**

```bash
git add lib/slack/canvas.ts
git commit -m "feat(sca): deleteCanvas helper (canvases.delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: draft.ts — blocks opener + the three cleanup handlers

**Files:**
- Modify: `lib/draft.ts`

**Interfaces:**
- Consumes: `buildOpenerBlocks`, `buildDoneConfirmBlocks`, `DRAFT_DONE_*` (Task 1); `deleteCanvas` (Task 2); existing `getIdea`, `getProfileBySlackUser`, `slack`, `scaClient`, `safePost`, `updateOrPost`, `PLATFORM_LABEL`, `Platform`.
- Produces: `export async function handleDraftDone(payload: unknown): Promise<void>`, `handleDraftDoneConfirm`, `handleDraftDoneCancel`.

**Design note (no unit test):** `lib/draft.ts` is Slack/DB I/O, verified by tsc + live pass (repo convention). Keep every handler non-throwing.

- [ ] **Step 1: Update imports and swap the opener to blocks**

In `lib/draft.ts`:
- Add to the digest import: `buildOpenerBlocks, buildDoneConfirmBlocks, DRAFT_DONE_ACTION, DRAFT_DONE_CONFIRM_ACTION, DRAFT_DONE_CANCEL_ACTION` (alongside the existing `parsePlatformValue, ...`).
- Add to the canvas import: change `import { createCanvasInDM } from "@/lib/slack/canvas";` to `import { createCanvasInDM, deleteCanvas } from "@/lib/slack/canvas";`.
- **Delete** the local `OPENER` and `REDACTED_NOTE` constants (near the top) — `REDACTED_NOTE` now lives in `lib/digest.ts` and the opener text is built by `buildOpenerBlocks`.

In `draftOnePlatform`, replace the opener block (currently building `openerText` from `OPENER`/`REDACTED_NOTE` and posting `text`) with a blocks post. The relevant section becomes:
```typescript
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
```
(`canvasTitle` is already imported in draft.ts from the title-tag change. Everything else in `draftOnePlatform` — the `sca_thread_map` insert, the try/catch — is unchanged.)

- [ ] **Step 2: Add a thread-map lookup helper**

Add near `threadTsForIdea` (this resolves a cleanup click's opener message back to its draft row):
```typescript
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
```

- [ ] **Step 3: Add the three handlers**

Add at the end of `lib/draft.ts`. Each reads the acted-on opener's `ts` from the payload (`message.ts`, falling back to `container.message_ts`), looks up the row, and edits that message in place.

```typescript
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
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit`
Expected: clean (no more `OPENER`/`REDACTED_NOTE` references in draft.ts; confirm with `grep -n "OPENER\|REDACTED_NOTE" lib/draft.ts` → no matches).
Run: `npm test`
Expected: all green (no draft.ts unit tests; digest + generation suites pass).

- [ ] **Step 5: Commit**

```bash
git add lib/draft.ts
git commit -m "feat(sca): self-describing opener blocks + Done/confirm/cancel cleanup handlers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: route — dispatch the cleanup actions

**Files:**
- Modify: `app/api/slack/interactivity/route.ts`

**Interfaces:**
- Consumes: `handleDraftDone`, `handleDraftDoneConfirm`, `handleDraftDoneCancel` (Task 3); `DRAFT_DONE_ACTION`, `DRAFT_DONE_CONFIRM_ACTION`, `DRAFT_DONE_CANCEL_ACTION` (Task 1).

- [ ] **Step 1: Add imports**

Extend the two imports:
```typescript
import { handleDraftThis, handleDraftPlatform, handleDraftRetry, handleDraftDone, handleDraftDoneConfirm, handleDraftDoneCancel } from "@/lib/draft";
import { DRAFT_THIS_ACTION, DRAFT_PLATFORM_ACTION, DRAFT_RETRY_ACTION, DRAFT_DONE_ACTION, DRAFT_DONE_CONFIRM_ACTION, DRAFT_DONE_CANCEL_ACTION } from "@/lib/digest";
```

- [ ] **Step 2: Extend the dispatch (exact match for the done-family)**

The current dispatch block is:
```typescript
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
```
Add three exact-match branches (exact, because `draft_done` is a prefix of the other two):
```typescript
  if (payload.type === "block_actions") {
    const actionId = payload.actions?.[0]?.action_id ?? "";
    if (actionId === DRAFT_THIS_ACTION) {
      waitUntil(handleDraftThis(payload)); // ack now, do slow work after responding
    } else if (actionId.startsWith(DRAFT_PLATFORM_ACTION)) {
      waitUntil(handleDraftPlatform(payload));
    } else if (actionId.startsWith(DRAFT_RETRY_ACTION)) {
      waitUntil(handleDraftRetry(payload));
    } else if (actionId === DRAFT_DONE_ACTION) {
      waitUntil(handleDraftDone(payload));
    } else if (actionId === DRAFT_DONE_CONFIRM_ACTION) {
      waitUntil(handleDraftDoneConfirm(payload));
    } else if (actionId === DRAFT_DONE_CANCEL_ACTION) {
      waitUntil(handleDraftDoneCancel(payload));
    }
  }
```
**Ordering caveat:** the `startsWith(DRAFT_PLATFORM_ACTION)`/`startsWith(DRAFT_RETRY_ACTION)` branches don't collide with `draft_done*` (different roots), so exact `draft_done*` branches can safely come after. Do not convert the done-family to `startsWith`.

- [ ] **Step 3: Typecheck + suite**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add app/api/slack/interactivity/route.ts
git commit -m "feat(sca): dispatch draft_done / _confirm / _cancel cleanup actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Live verification on Vercel

**Files:** none (verification only).

- [ ] **Step 1: Deploy + sync**

Run `vercel --prod --yes`, confirm READY + aliased to `https://sales-content-assistant.vercel.app`, then `git push origin main` to keep the remote in sync.

- [ ] **Step 2: Opener labeling (fixes the "Both" identical-openers bug)**

Fire a digest, click **Draft this** as a both-channel rep, choose **Both** → confirm the two openers are now **distinct**: one *"**LinkedIn draft** … `LI: <hook>`"*, one *"**Instagram draft** … `IG: <hook>`"*, each with a **✓ Done** button.

- [ ] **Step 3: Done → confirm → delete**

Click **✓ Done** on one opener → it swaps to *"Delete the `LI: <hook>` canvas? This can't be undone."* with **Yes, delete** / **Keep**. Click **Yes, delete** → the canvas disappears from the DM and the opener shows *"Cleared ✅ — LinkedIn draft canvas removed."*

- [ ] **Step 4: Verify the row survived**

In the SCA Supabase SQL editor:
```sql
select idea_id, platform, canvas_id, thread_ts from sca_thread_map order by created_at desc limit 5;
```
Confirm the cleaned draft's row is still present with `canvas_id` **null** (row not deleted — utilization data intact), platform/thread_ts unchanged.

- [ ] **Step 5: Keep + idempotency**

On another draft, click **✓ Done** → **Keep** → confirm the opener reverts to the ready state (Done button back). Click **✓ Done → Yes, delete**, then click **Yes, delete** again if the button is still there / re-trigger → confirm it stays "Cleared ✅" with no error (idempotent), no second delete attempt surfaced.

- [ ] **Step 6: Scope check**

Confirm `canvases.delete` succeeded under the existing `canvases:write` scope (Step 3 working proves it). If it returned a `missing_scope`/permission error in `vercel logs`, note the scope to add to the Slack app.

---

## Self-Review

**Spec coverage:**
- Self-describing platform-labeled openers → Task 1 (`buildOpenerBlocks`) + Task 3 (draftOnePlatform posts them); live Step 2. ✅
- Manual two-step Done flow (Done → confirm → delete; Keep reverts) → Task 1 (`buildDoneConfirmBlocks`) + Task 3 (three handlers); live Steps 3/5. ✅
- `deleteCanvas` helper → Task 2. ✅
- Keep row, null canvas_id, no migration → Task 3 (`handleDraftDoneConfirm` update); live Step 4. ✅
- Idempotency via null canvas_id → Task 3 (early Cleared branch); live Step 5. ✅
- Delete-failed keeps state honest → Task 3 (return-before-null on catch). ✅
- Unique confirm action_ids + exact-match routing → Task 1 (distinct ids, tested) + Task 4 (exact branches). ✅
- Utilization-tracker protection (row survives) → Task 3 + live Step 4. ✅
- `canvases:write` scope reuse → live Step 6. ✅

**Placeholder scan:** no TBD/TODO; every code step shows full code; commands have expected output. ✅

**Type consistency:** `buildOpenerBlocks(platform, hook, canvasId, opts?)` and `buildDoneConfirmBlocks(platform, hook, canvasId)` signatures match between Task 1 (definition/tests) and Task 3 (calls); `threadMapByThreadTs` returns `{canvas_id, platform, idea_id, rep_id}` consumed by all three handlers; `DRAFT_DONE_*` constants consistent across Tasks 1/3/4; `deleteCanvas(canvasId)` consistent Task 2↔3. ✅
