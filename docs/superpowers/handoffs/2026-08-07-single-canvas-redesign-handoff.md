# Handoff — Single-Canvas-Per-Platform Redesign (plan-writing session)

**Created:** 2026-08-07
**For:** a fresh session that will run `superpowers:writing-plans` on the approved spec, then
build it via `superpowers:subagent-driven-development`.
**Start here:** read the spec, then invoke `superpowers:writing-plans`.
Spec: `docs/superpowers/specs/2026-08-07-single-canvas-per-platform-design.md` (APPROVED by Trent).

This doc is the context the spec doesn't carry. Read it before planning.

## Current state

- Branch `main`, HEAD `aee236c` (spec commit). Working tree clean. This repo IS its own git repo
  (`git rev-parse --show-toplevel` = the sca dir), despite living inside the Claude-Projects monorepo.
- The multi-platform drafting feature + the (now-superseded) canvas-cleanup feature are BOTH shipped
  and LIVE on prod `https://sales-content-assistant.vercel.app`. Full task-by-task history is in
  `.superpowers/sdd/progress.md` (the SDD ledger) — read its top two sections.
- 90 unit tests green, `tsc` clean as of HEAD.

## This redesign REMOVES live code

The cleanup feature (Done button → `canvases.delete`) is live but its approach is wrong (see the
spec's "Why this supersedes" — delete leaves an unremovable, accumulating DM tombstone). The plan
must remove: `deleteCanvas`, `handleDraftDone/Confirm/Cancel`, `buildDoneConfirmBlocks`,
`DRAFT_DONE_*`, the Done button in `buildOpenerBlocks`, the three `draft_done*` route branches, and
their unit tests. Removal ships to prod with the new flow — don't leave it dormant.

## Repo conventions (the plan must follow these)

- **Testing split:** pure logic is unit-tested with Vitest (`npm test`); Slack/RAG/AI I/O AND thin
  DB wrappers (e.g. `lib/draft.ts`, `lib/slack/canvas.ts`, most of `lib/ideas.ts`) are NOT
  unit-tested — verified by `tsc` + a live Vercel pass. So the plan's tests target only the pure
  `lib/digest.ts` block builders + value parsing.
- **TDD** for the pure pieces (failing test first). **Typecheck:** `npx tsc --noEmit` (no
  `noUnusedLocals`, so dead imports pass tsc — watch for them manually).
- **Commit directly to `main`.** Stage only the specific files per task (`git add <paths>`, then
  confirm `git diff --cached --name-only`) — do NOT `git add -A`.
- **Post-ack invariant:** all interactivity handlers run in `waitUntil` and must NEVER throw.

## Deploy model — READ THIS (it broke prod once)

Ship via `vercel --prod --yes` (CLI, uploads local working tree), THEN `git push origin main`.
The GitHub remote must stay in sync: a Vercel Git-integration build of a stale remote once served
old code and 404'd every route. Details + the SENSITIVE-env-var gotcha are in the
`sca-deployment-model` auto-memory. Live-verification endpoints (`/api/digest/generate`,
`/api/pool/refill`) are gated by `Authorization: Bearer $SCA_INTERNAL_KEY` (a Vercel *sensitive*
var — unreadable; Trent holds the value). Firing a digest is how you make "Draft this" appear;
the weekly cron (step 8) is NOT built.

## Live-learned Slack canvas facts (don't re-discover these)

- A canvas `canvas_id` IS a file id (e.g. `F0BPDJ2KQ1K`); `files.delete({file: canvasId})` is valid.
- `canvases.edit` full-document `replace` updates the SAME canvas in place, leaves NO stub — this is
  the mechanism the whole redesign relies on. `createCanvasInDM` uses `conversations.canvases.create`
  (renders inline in the DM; Spike B found standalone `canvases.create`+link does NOT).
- Conversation canvases stack at the TOP of the DM and accumulate. Deleting one (`canvases.delete`
  OR `files.delete`) leaves a permanent "deleted by owner" tombstone no API removes. **Do not
  propose any delete-based approach.**
- Slack rejects duplicate `action_id`s within one actions block (`invalid_blocks`). Every button in
  a block needs a unique `action_id`. The `draft_platform`/`draft_retry` buttons encode
  `"<action>:<selection>"` and the route matches them by `startsWith`; the `draft_done*` family used
  EXACT match because `draft_done` is a prefix of `draft_done_confirm`/`_cancel`. The new
  `draft_replace_confirm`/`draft_replace_cancel` are distinct strings (neither prefixes the other) —
  exact match is fine.

## Key current signatures the plan builds on

- `lib/generation.ts` exports: `type Platform = "linkedin"|"instagram"`, `PLATFORM_LABEL`
  (LinkedIn/Instagram), `PLATFORM_TAG` (LI/IG), `canvasTitle(platform, hook)` ("LI: <hook>"),
  `generateDraft(idea, profile, moment, platform)` (guardrail inside — unchanged).
- `lib/digest.ts` exports the block builders + `parsePlatformValue(value) -> {ideaId, selection}|null`,
  `platformsForSelection`, `encodePlatformValue`, and the action constants.
- `lib/ideas.ts`: `claimIdea(ideaId, repId)` (atomic candidate→used, returns claimed/already_used/
  not_found) and `getIdea(ideaId, repId)` (fetch, no status change — the retry/replace path uses this).
- `lib/draft.ts`: `draftOnePlatform(idea, profile, channel, moment, platform, reuseTs)` (create-only
  today — the redesign makes it reuse-aware), `claimAndDraft`, `handleDraftThis`,
  `handleDraftPlatform`, `handleDraftRetry` (per-platform retry on partial failure — KEEP; it already
  uses `getIdea` and will inherit reuse-awareness for free), plus `safePost`/`updateOrPost`/
  `threadTsForIdea` helpers.
- `lib/slack/canvas.ts`: `createCanvasInDM`, `editCanvas`, `deleteCanvas` (to be removed).

## Claim model (the subtle part)

Claim-at-commit: claim the idea (`claimIdea`) at Draft this (single-channel) / platform pick (both),
BEFORE the replace-confirms. Per-platform drafts then use `getIdea` (no re-claim) — same pattern as
the existing retry path. Rationale: per-platform async confirms make a single atomic claim awkward;
claiming once up front avoids a "claim exactly once across two async platform drafts" race. Accepted
consequence: committing then Keeping every existing draft still consumes the idea.

## Process Trent prefers

brainstorm (done) → `writing-plans` → `subagent-driven-development` (fresh implementer per task,
task review after each, final whole-branch review, fix wave). Model tiers: cheap for
transcription/1-file, standard for integration, most-capable for the `draft.ts` handler task + the
final review. Live-verification (Task ~5) is a Trent hand-off (deploy + Slack click-through) — and
matters MORE here because this both removes live code and rewrites the core draft path.

## Related follow-ups (not blockers)

- Background task chip filed: orphaned-canvas-on-insert-failure (draft.ts creates the canvas before
  the row insert). The reuse model may change this calculus — worth a look during planning.
- Step 7 (iteration loop) and step 8 (weekly cron) still owed for Phase 1. This redesign is designed
  so step-7 slots in cleanly (thread reply → regenerate → `canvases.edit` the shared canvas); step-7
  must guard against iterating a stale/superseded thread. Not built here.
