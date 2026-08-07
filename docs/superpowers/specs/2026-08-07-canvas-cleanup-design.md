# Sales Content Assistant — Draft Canvas Cleanup Design

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Phase 1 build-order step:** NEW scope (follows the multi-platform feature; adjacent to the
step-7 iteration loop, still unbuilt)
**Builds on:** [multi-platform drafting](2026-08-05-multiplatform-drafting-design.md) (the
`draftOnePlatform` opener + `sca_thread_map` row this extends) and
[step 6 draft-this](2026-08-04-draft-this-interactivity.md) (the canvas helpers + interactivity
route).

## Goal

Reps accumulate bot-owned draft canvases in their DM that they can't delete from the Slack UI.
Give each draft a visible, self-describing way to be cleared once it's served its purpose: the
rep clicks **Done** on the draft's opener message and the bot deletes that canvas. Along the way,
fix a rough edge shipped with multi-platform — for a "Both" draft the two opener messages are
identical, so the rep can't tell which thread/canvas is which. Each opener becomes
platform-labeled and names its canvas.

## Scope

**In scope:**
- **Self-describing openers** — each `draftOnePlatform` opener names its platform and canvas
  (`LI: <hook>` / `IG: <hook>`), fixing the identical-"Both"-openers problem.
- **A manual "Done" cleanup flow** on the opener message: a two-step confirm
  (`Done → Yes,delete / Keep`) that deletes the platform's canvas and marks the row cleaned.
- **`deleteCanvas` helper** (`slack.canvases.delete`) in `lib/slack/canvas.ts`.
- The three new interactivity actions + handlers and their route dispatch.

**Out of scope (deferred):**
- **Auto-cleanup** (age-based sweep, or on-next-digest). v1 is manual only. An age-based
  safety-net sweep can be a later phase once we see how canvases actually accumulate — and it
  would ride on the not-yet-built weekly cron (step 8).
- **Step 7 iteration loop** — unchanged by this; a cleaned draft (canvas_id null) is simply not
  iterable, which is the correct behavior.

## Inherited principles (binding)

1. **Rep is the author.** The bot never deletes a draft on its own judgment — cleanup is
   rep-initiated, and irreversible deletion is gated behind an explicit two-step confirm.
2. **Post-ack invariant.** Every handler runs inside `waitUntil` and never throws.
3. Private only (rep ↔ bot DM); rep resolved fresh per request.
4. **The utilization-tracker data must survive cleanup.** The future utilization tracker counts
   `sca_thread_map` rows per rep/month, so cleanup must NOT delete rows — only the Slack canvas.

## Key decisions (resolved in brainstorm, 2026-08-07)

1. **Trigger: a manual "Done" button**, not auto-cleanup. Respects rep-as-author; the bot never
   guesses whether a draft is finished.
2. **The button lives on the opener message, not the canvas** — Slack canvases can't hold
   interactive elements; buttons only exist on messages. The opener is a top-level DM message
   (the thread parent), so its button is visible without opening any thread.
3. **Two-step confirm** — canvas deletion is irreversible, so `Done` first swaps the opener to a
   confirm prompt (`Yes, delete` / `Keep`); only `Yes` deletes.
4. **Keep the `sca_thread_map` row; null its `canvas_id`** on delete. No schema migration
   (`canvas_id` is already nullable). The null value triple-duties as the cleaned-marker, the
   tracker-safe record (all other fields survive), and the idempotency guard.
5. **Openers are platform-labeled** (`LI:/IG: <hook>`), reusing the tags shipped with the title
   change, so a "Both" draft's two threads are distinguishable and each ties to its canvas.

## Button contracts (new)

All posted on the opener message; each button carries a unique `action_id` (the lesson from the
`invalid_blocks` bug where duplicate action_ids in one actions block were rejected).

- **State 1 (Ready):** one button — `action_id: "draft_done"`, `value: <thread_map row id or
  canvas_id>` (backup identifier; the primary key is the opener's own `ts`).
- **State 2 (Confirm):** two buttons in one actions block — `action_id: "draft_done_confirm"` and
  `action_id: "draft_done_cancel"`, same `value`.

Constants exported from `lib/digest.ts`: `DRAFT_DONE_ACTION = "draft_done"`,
`DRAFT_DONE_CONFIRM_ACTION = "draft_done_confirm"`, `DRAFT_DONE_CANCEL_ACTION = "draft_done_cancel"`.

## Architecture

### 1. Self-describing opener — `lib/digest.ts` (pure builder) + `lib/draft.ts`

`buildOpenerBlocks(platform, hook, opts?: { wasRedacted?: boolean }): KnownBlock[]` — a section
with the platform-labeled text naming the canvas, plus an actions block with the `✓ Done` button:

> **LinkedIn draft** — your first cut is in the canvas **`LI: <hook>`** above. Reply in a thread
> to tell me what to change. When you've posted it, hit **Done** and I'll clear the canvas.
> `[ ✓ Done — clear this draft ]`

(Instagram: **Instagram** / **`IG: <hook>`**.) When `wasRedacted`, the existing redaction caveat
appends to the section text.

`draftOnePlatform` (in `lib/draft.ts`) changes only in how it posts/updates the opener: it now
sends `blocks: buildOpenerBlocks(platform, idea.hook, { wasRedacted })` (with a text fallback for
notifications) instead of the plain `OPENER` string, on both the interim-reuse (`chat.update`)
and fresh-post (`chat.postMessage`) paths. The `thread_ts = opener.ts` contract is unchanged, so
the `sca_thread_map` write is unchanged.

### 2. Confirm prompt — `lib/digest.ts` (pure builder)

`buildDoneConfirmBlocks(platform, hook): KnownBlock[]` — a section: *"Delete the **`LI: <hook>`**
canvas? This can't be undone."* + an actions block with `[ Yes, delete ]`
(`DRAFT_DONE_CONFIRM_ACTION`) and `[ Keep ]` (`DRAFT_DONE_CANCEL_ACTION`), each a unique
`action_id`, both carrying the same `value` as the Done button.

### 3. Canvas delete helper — `lib/slack/canvas.ts`

`deleteCanvas(canvasId: string): Promise<void>` — wraps `slack.canvases.delete({ canvas_id })`.
Throws on API error so the caller can keep the row/opener honest (does not swallow). Requires the
`canvases:write` scope, already granted in step 6 (verified in the live pass).

### 4. Handlers — `lib/draft.ts`

All run post-ack in `waitUntil`, never throw, and locate the draft by looking up `sca_thread_map`
on `(slack_channel, thread_ts)` where `thread_ts` is the acted-on opener message's `ts` (from the
interactivity payload). Each also resolves the idea via `getIdea(idea_id, repId)` to reconstruct
the `LI:/IG: <hook>` label, with a generic "this {platform} draft" fallback when `idea_id` is
null/missing.

- `handleDraftDone(payload)` — edit the opener to `buildDoneConfirmBlocks(...)` (state 1→2).
- `handleDraftDoneConfirm(payload)` — read the row; if `canvas_id` is set, `deleteCanvas(canvasId)`
  → update the row `canvas_id = null` → edit opener to a plain "Cleared ✅ — {platform} draft
  canvas removed." (state 3). If `canvas_id` is already null (double-click / already cleared),
  skip the delete and just render Cleared (idempotent). If `deleteCanvas` throws, leave the row
  and keep the opener in the confirm state with a soft "couldn't remove that just now — try
  again" note.
- `handleDraftDoneCancel(payload)` — edit the opener back to `buildOpenerBlocks(...)` (state 2→1).
  Re-renders without the redaction caveat (not persisted — accepted minor).

### 5. Route — `app/api/slack/interactivity/route.ts`

Dispatch the three new actions with **exact** matches (not `startsWith`), because `"draft_done"`
is a prefix of `"draft_done_confirm"`/`"draft_done_cancel"` and prefix-matching would misroute:
- `actionId === DRAFT_DONE_ACTION` → `handleDraftDone`
- `actionId === DRAFT_DONE_CONFIRM_ACTION` → `handleDraftDoneConfirm`
- `actionId === DRAFT_DONE_CANCEL_ACTION` → `handleDraftDoneCancel`

`draft_this` stays exact; `draft_platform`/`draft_retry` keep their `startsWith` (they carry
`:selection` suffixes). `maxDuration = 120` unchanged.

## Data model

No schema migration. On confirmed delete, `sca_thread_map.canvas_id` (already nullable) is set to
null; every other column (`rep_id`, `slack_channel`, `thread_ts`, `idea_id`, `platform`,
`created_at`) is preserved, keeping the row as the durable draft record for the utilization
tracker. `canvas_id = null` is the cleaned-marker and idempotency guard.

## Testing

Same split the repo uses: pure logic unit-tested (Vitest); Slack/DB I/O verified on one live
Vercel deploy.

**Unit (pure, mocked — no secrets):**
- `buildOpenerBlocks` — text names the platform and the `LI:/IG: <hook>` canvas; carries exactly
  one `draft_done` button; redaction caveat present when `wasRedacted`, absent otherwise.
- `buildDoneConfirmBlocks` — the two buttons carry **unique** `action_id`s
  (`draft_done_confirm` ≠ `draft_done_cancel`) — the structural assertion class that would have
  caught the earlier duplicate-action_id bug — and both encode the same value.

**Live-verified on prod:** draft a post → the opener is platform-labeled and names its canvas →
click **Done** → confirm prompt appears → **Yes, delete** → the canvas disappears from the DM, the
`sca_thread_map` row survives with `canvas_id` null, opener shows "Cleared ✅"; **Keep** reverts to
the ready opener; a **"Both"** draft shows two distinct platform-labeled openers; and
`canvases.delete` succeeds under the existing `canvases:write` scope.

## Risks

- **Irreversible deletion** — mitigated by the two-step confirm; the bot never auto-deletes.
- **State lying about reality** — the delete-failed path never nulls the row or shows "Cleared"
  unless `canvases.delete` actually succeeded.
- **`canvases:write` may not cover delete** — unverified until the live pass; if delete needs a
  different scope, that's a Slack app-config change caught live, not in unit tests.
- **Utilization-tracker coupling** — explicitly protected: rows are never deleted, only
  `canvas_id` is nulled, so per-rep/month counts are unaffected.
- **Double-click / stale confirm** — the `canvas_id` null idempotency guard makes a repeated
  confirm a no-op that renders Cleared.

## Build order (each independently testable)

1. `lib/digest.ts` — `buildOpenerBlocks` + `buildDoneConfirmBlocks` + the three `DRAFT_DONE_*`
   constants, with unit tests (including the unique-action_id assertion).
2. `lib/slack/canvas.ts` — `deleteCanvas`.
3. `lib/draft.ts` — `draftOnePlatform` posts `buildOpenerBlocks`; add `handleDraftDone`,
   `handleDraftDoneConfirm`, `handleDraftDoneCancel` + the row/idea lookup for label rebuild.
4. `app/api/slack/interactivity/route.ts` — dispatch the three new actions (exact match).
5. Live integration verification (draft → Done → confirm → delete → Cleared; Keep revert; Both
   distinct openers; scope check).
