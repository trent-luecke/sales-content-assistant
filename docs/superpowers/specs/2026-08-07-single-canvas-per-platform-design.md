# Sales Content Assistant — Single-Canvas-Per-Platform Redesign

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Phase 1 build-order step:** NEW scope — supersedes the [canvas-cleanup design](2026-08-07-canvas-cleanup-design.md), which live-testing proved uses the wrong lever.
**Builds on:** the multi-platform drafting feature (the `draftOnePlatform` fan-out, `sca_thread_map.platform`, the opener labeling) and the shipped draft loop.

## Why this supersedes canvas cleanup

The canvas-cleanup feature (manual "Done" → `canvases.delete`) shipped and was live-verified — and the verification revealed the approach is wrong. Deleting a conversation-attached canvas leaves a **"deleted by owner" tombstone pinned at the top of the DM that no API removes** (confirmed live: both `canvases.delete` and `files.delete` tombstone; `files:write` is present and `files.delete` returned `ok:true` but still left a stub). Because canvases stack at the top of the DM, these stubs **accumulate and bury new canvases** as drafting continues. Deletion cannot solve the clutter.

The fix is to **stop creating a new canvas per draft**. Reuse one canvas per platform, editing it in place — so nothing ever accumulates and there is nothing to clean up.

## Goal

A rep has at most **one LinkedIn canvas and one Instagram canvas**, each reused across all their drafts for that platform (updated in place via `canvases.edit`). Drafting a new idea for a platform that already has a canvas prompts a **replace-confirm** before overwriting. No deletion, no tombstones, no accumulation.

## Scope

**In scope:**
- Reuse one canvas per `(rep, platform)`: first draft creates it, every later draft `canvases.edit`s it.
- A **replace-confirm** step before overwriting an existing platform canvas (per-platform for "Both").
- **Claim-at-commit** (Draft this for single-channel / platform pick for both-channel), with per-platform drafts using `getIdea` (no re-claim).
- **Removal** of the entire delete-based cleanup flow (see "Removals").
- Slimming the opener to platform-labeled text without a Done button (keeps the "which thread is which" clarity).

**Out of scope (deferred):**
- **Step 7 (iteration loop)** — this model is designed so step-7 slots in cleanly (a thread reply regenerates and `canvases.edit`s the shared canvas), but step-7 itself is not built here.
- **Auto/utilization features** — unchanged; the per-draft `sca_thread_map` rows this preserves are the tracker's data source.

## Inherited principles (binding)

1. Rep is the author; the AI never publishes.
2. **No customer/prospect/deal specifics in generated content** — the anonymization guardrail in `generateDraft` is unchanged.
3. Private only (rep ↔ bot DM); rep resolved fresh per request.
4. **Post-ack invariant:** every handler runs inside `waitUntil` and never throws.
5. **Utilization-tracker data survives:** each draft still writes an `sca_thread_map` row; nothing is deleted.

## Key decisions (resolved in brainstorm, 2026-08-07)

1. **Model A — no "Done" affordance.** Reuse eliminates accumulation, so the Done/delete flow is dropped entirely.
2. **New opener per draft** (its own thread), while the canvas is reused. Old threads remain as history; step-7 will guard against iterating a stale (superseded) thread.
3. **Per-platform replace-confirm** for "Both" — the rep can Replace one platform and Keep the other; the two platforms resolve independently/asynchronously.
4. **Claim-at-commit.** The idea is claimed (marked `used`) at Draft this (single) / platform pick (both), before the replace-confirms. Consequence accepted: committing then Keeping every existing draft still consumes the idea. This avoids a race-prone "claim exactly once across two async platform drafts" problem.

## Data model

**No schema migration.** The `platform` column already exists and `canvas_id` is already nullable.

- **Current canvas lookup:** the reusable canvas for `(rep, platform)` is the `canvas_id` of the most recent `sca_thread_map` row for that `rep_id` + `platform` with a non-null `canvas_id`.
- **Row per draft:** every draft inserts a new `sca_thread_map` row `{ rep_id, slack_channel, thread_ts (new opener ts), canvas_id (reused or newly created), idea_id, platform }`. Multiple rows share one `canvas_id`; the latest row per `(rep, platform)` is the current draft. Unique constraint `(slack_channel, thread_ts)` is unaffected (each opener is a new message).

## Architecture

### 1. Reuse-aware draft helper — `lib/draft.ts`

The create-only logic in `draftOnePlatform` is replaced by a reuse-aware path:
1. `currentCanvasId(repId, platform)` (new DB lookup) → the latest non-null `canvas_id` for `(rep, platform)`, or `null`.
2. Generate the draft (`generateDraft`, unchanged, guardrail intact).
3. If a current canvas exists → `editCanvas(canvasId, body)`; **if that throws** (canvas gone) → `createCanvasInDM(...)` as a fallback. If none exists → `createCanvasInDM(...)`.
4. Post a fresh opener (new thread), insert the `sca_thread_map` row with the effective `canvas_id`.

Both the direct-draft path and the replace-confirm path use this helper. It never throws (returns an ok/fail result), preserving the post-ack invariant.

### 2. Openers & confirm blocks — `lib/digest.ts` (pure builders)

- `buildOpenerBlocks(platform, hook)` — **slimmed**: platform-labeled text that names the canvas (`LI:/IG: <hook>`), **no Done button**.
- `buildReplaceConfirmBlocks(ideaId, platform, hook)` — *"You have a current {LinkedIn} draft in its canvas. Replace it with this new one?"* + `[Replace]` (`DRAFT_REPLACE_CONFIRM_ACTION`) and `[Keep current]` (`DRAFT_REPLACE_CANCEL_ACTION`), each a unique `action_id`, both `value: "<ideaId>|<platform>"`.

New constants: `DRAFT_REPLACE_CONFIRM_ACTION = "draft_replace_confirm"`, `DRAFT_REPLACE_CANCEL_ACTION = "draft_replace_cancel"`.

### 3. Handlers — `lib/draft.ts`

All post-ack, never throw.
- `handleDraftThis` (single-channel path) — resolve profile; **claim at commit** (`claimIdea`; `already_used` → nudge, `not_found` → soft error); then for the platform: `currentCanvasId` exists → post `buildReplaceConfirmBlocks`; else → reuse-aware draft now.
- `handleDraftPlatform` (Both) — resolve profile; **claim at commit**; then per chosen platform independently: existing canvas → its own replace-confirm; no canvas → draft now.
- `handleDraftReplaceConfirm` — parse `ideaId|platform`; `getIdea` (no re-claim; null → soft error); reuse-aware draft for that platform; edit the confirm message to a short "drafting…/done" state.
- `handleDraftReplaceCancel` — edit the confirm message to *"Kept your current {LinkedIn} draft 👍"*; nothing else (idea stays consumed).

### 4. Removals

Delete the superseded cleanup surface: `deleteCanvas` (`lib/slack/canvas.ts`); `handleDraftDone`/`handleDraftDoneConfirm`/`handleDraftDoneCancel` and any Done-only helpers (`lib/draft.ts`); `buildDoneConfirmBlocks` and `DRAFT_DONE_ACTION`/`_CONFIRM`/`_CANCEL` (`lib/digest.ts`); the Done button inside `buildOpenerBlocks`; and their three `draft_done*` route branches. Remove the now-orphaned unit tests for those builders.

### 5. Route — `app/api/slack/interactivity/route.ts`

Drop the three `draft_done*` exact-match branches; add exact-match branches for `draft_replace_confirm` → `handleDraftReplaceConfirm` and `draft_replace_cancel` → `handleDraftReplaceCancel`. `draft_this` stays exact; `draft_platform`/`draft_retry` keep `startsWith`. `maxDuration = 120` unchanged.

## Testing

Same split the repo uses.

**Unit (pure, mocked):**
- `buildReplaceConfirmBlocks` — correct copy, two **unique** `action_id`s, both encode `"<ideaId>|<platform>"`.
- `buildOpenerBlocks` (slimmed) — platform label + `LI:/IG: <hook>` canvas name, **no** actions block / button.
- Removed builders' tests are deleted (not left asserting gone code).

**Live-verified on prod (the real proof):**
- Draft LinkedIn once → a canvas is created. Draft LinkedIn again → **replace-confirm → Replace → the *same* canvas updates in place; no new canvas, no stub.** Over several drafts, the LinkedIn canvas count stays at **exactly one**.
- **Keep current** → the canvas is untouched and the idea is consumed (won't resurface).
- **Both** with one platform already having a canvas and one not → the empty one drafts immediately, the other shows its replace-confirm; independent outcomes.

## Risks

- **Reuse edit fails** (canvas deleted out from under us) → the reuse helper falls back to `createCanvasInDM`, so drafting never dead-ends.
- **Claim-at-commit consumes an idea on full-Keep** → accepted; rare and low-cost (pool refills), and it buys a race-free model.
- **Stale threads** (an old draft's thread whose canvas was since replaced) → benign until step-7 exists; step-7 must detect non-latest threads and tell the rep the draft was superseded. Documented for that build.
- **Removing shipped, live code** → the delete-based cleanup surface is removed; the build deploys the removal + new flow together and re-verifies live.

## Build order (each independently testable)

1. `lib/digest.ts` — add `DRAFT_REPLACE_*` constants + `buildReplaceConfirmBlocks`; slim `buildOpenerBlocks` (drop the Done button); remove `buildDoneConfirmBlocks` + `DRAFT_DONE_*`; update/remove tests.
2. `lib/slack/canvas.ts` — remove `deleteCanvas`.
3. `lib/draft.ts` — `currentCanvasId` lookup + reuse-aware draft helper; claim-at-commit in `handleDraftThis`/`handleDraftPlatform`; add `handleDraftReplaceConfirm`/`Cancel`; remove the three `handleDraftDone*` handlers.
4. `app/api/slack/interactivity/route.ts` — swap the `draft_done*` branches for `draft_replace_*`.
5. Live verification (one-canvas-per-platform reuse; replace-confirm; Keep; Both mixed; no stubs, no accumulation).
