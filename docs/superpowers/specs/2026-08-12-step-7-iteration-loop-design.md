# Step 7 — In-Thread Iteration Loop (Design)

**Date:** 2026-08-12
**Status:** Approved (brainstorm), ready for plan
**Depends on:** Step 6 (draft-this interactivity), multi-platform drafting, single-canvas-per-platform,
threaded-drafting Part A/B — all live on `main`.

## Purpose

After a rep drafts a post, let them refine it without leaving the Slack thread. The rep clicks a
preset button under the draft's opener ("Shorter", "Punchier", "Less salesy", "Different angle");
the system regenerates the post **building on the current draft**, edits the **same** canvas in
place, and confirms in-thread. Clicking several buttons in a row compounds — this is the iteration
loop that closes Phase 1's drafting story.

## Decisions (from brainstorm)

- **Preset buttons, not free-form replies.** Refinement is a block-action button click, so it flows
  through `/api/slack/interactivity` (the same endpoint as "Draft this"), **not** `/api/slack/events`.
  Consequence: the historic "step-7 dependency" — persist `root_ts` to map a free-form reply back to
  a draft, and disambiguate Both-rep threads — **does not apply**. Each button's `value` carries
  `<ideaId>|<platform>`, so a click names its target draft unambiguously.
- **Build on the current draft.** Each refine feeds the model the current post body plus the
  directive, so "Shorter" then "Add-a-stat"-style tweaks compound. This requires persisting the
  current body (see Data model).
- **Button set:** Shorter, Punchier, Less salesy, Different angle. ("Different angle" reframes the
  same idea from a new opening — not a from-scratch reset.)
- **Unbounded loop.** Buttons persist on the opener; each click is one edit-in-place + one LLM call.
  No cap (nothing accumulates in Slack — the canvas is replaced, not appended).

## Data model

One live migration, mirrored into `db/schema.sql` (same pattern as the `platform` column):

```sql
alter table sca_thread_map add column draft_body text;
```

- **Nullable.** Stores the current **assembled** body — the `generateDraft`/`refineDraft` return
  `body` (post-`assembleCanvasBody`, i.e. including the Instagram visual section when present), but
  **before** the `# <hook>` heading that `canvasDocument` prepends. That is exactly the text a
  refine must build on.
- Written on every draft create/reuse (in `draftOnePlatform`'s insert) and rewritten on every
  successful refine.
- Pre-migration rows have `null` → the refine handler self-heals (see Handler).

No other schema change. `root_ts` is **not** added (not needed — buttons carry the mapping).

## Components

### 1. `lib/generation.ts` — `refineDraft`

New exported function, sibling to `generateDraft`, reusing its guardrail machinery:

```
refineDraft(currentBody, kind, idea, profile, moment, platform)
  -> { body, wasRedacted }
```

- `kind` is one of the four button kinds. A `REFINE_DIRECTIVE: Record<RefineKind, string>` map turns
  each kind into instruction prose (e.g. Shorter → "Make this noticeably shorter and tighter without
  losing the core point.").
- Prompt = the same voice/platform/anonymization base built by `buildDraftPrompt` (so voice,
  platform length rules, and the HARD anonymization rule are all still in force), **plus** a section:
  "Here is the current post: «currentBody». Apply this change: «directive». Return ONLY the revised
  post." For Instagram, the stored `currentBody` is the assembled body — caption plus the labeled
  "Visual idea" section. The prompt tells the model that section is scaffolding to revise alongside
  the caption, and the base prompt's `===VISUAL===` contract still governs the fresh output, so
  `assembleCanvasBody` re-splits it cleanly. Acceptable v1 simplification; no separate caption store.
- Runs the **exact same** guardrail loop as `generateDraft`: model call → `containsAny` leak check →
  one retry with the anti-leak addendum → `redact` as last resort → `assembleCanvasBody`. Anonymization
  is therefore re-enforced on every refine, not just the first draft.
- Refactor: extract the shared guardrail loop (leak-check → retry → redact → assemble) so
  `generateDraft` and `refineDraft` call one helper rather than duplicating it. The only difference
  between them is the prompt (base vs base+current+directive).

### 2. `lib/digest.ts` — opener buttons

- Add `REFINE_ACTION = "refine"` and `REFINE_KINDS = ["shorter","punchier","less_salesy","different_angle"]`
  with a display-label map.
- `buildOpenerBlocks` gains an `ideaId` parameter and emits one actions block with four buttons.
  Each button: `action_id = "refine:<kind>"`, `value = encodePlatformValue(ideaId, platform)`
  (reuses the existing helper; `parsePlatformValue` parses it back). **Every button gets a distinct
  `action_id`** (the `invalid_blocks` lesson from the multi-platform incident) — the `:<kind>` suffix
  guarantees uniqueness within the one actions block.
- The opener already has no actions block today; this is purely additive. `wasRedacted` caveat and
  the platform-named copy are untouched.

### 3. `lib/draft.ts` — `handleRefine` + body persistence

- `draftOnePlatform` insert gains `draft_body: body` so new drafts are refine-ready immediately.
- New lookup: the `(rep, idea, platform)` row's `canvas_id` **and** `draft_body`
  (extend/add a helper alongside `threadTsForIdeaPlatform`/`currentCanvasId`).
- `handleRefine(payload)`:
  1. Parse `ideaId|platform` (`parsePlatformValue`) and `kind` (from `action_id` after `refine:`).
     Resolve `rootTs` via the existing `threadRoot(payload)`.
  2. Resolve profile; if missing → friendly thread notice, done.
  3. Look up the row. **No row / no `canvas_id`** (draft cleaned up or never mapped) → post an honest
     thread notice ("That draft's gone — grab a fresh one from your latest digest") and stop.
  4. Post a `↻ Refining your <Platform> draft…` interim reply under `rootTs`.
  5. Read the idea + demo moment (reuse the `getIdea` + `readDemoMoment` path from `handleDraftRetry`).
  6. If `draft_body` is present → `refineDraft(draft_body, kind, …)`. If `draft_body` is **null**
     (a pre-migration row, transient) → reconstruct a baseline via `generateDraft`, then
     `refineDraft` that baseline with the `kind` directive. Two model passes in this rare case, but
     the directive is honored, and the persist in sub-step 8 below leaves the row refine-ready after.
  7. `editCanvas(canvas_id, canvasDocument(idea.hook, newBody))`.
  8. `UPDATE sca_thread_map SET draft_body = newBody` for the row.
  9. Update the interim message into a confirmation: `↻ <Label> — updated your canvas above.`
     Append the redaction caveat when `wasRedacted`.
  - Wrapped so it **never throws post-ack** (matches every other handler in this file).

### 4. Interactivity route

Dispatch `action_id.startsWith("refine:")` → `waitUntil(handleRefine(payload))`, alongside the
existing `draft_this` / `draft_platform` / `draft_retry` / `draft_replace_*` cases. The
verify/parse/ack boundary and `maxDuration` are untouched. Match by `startsWith` (not exact),
consistent with `draft_platform`/`draft_retry`.

## Error handling & invariants

- **Never throw post-ack** — every `handleRefine` path is wrapped; failures degrade to an honest
  thread message.
- **Guardrail re-run on every refine** — anonymization is never weaker on a refined draft than on
  the first draft.
- **Missing/cleaned-up draft** — honest notice, no crash, no phantom canvas.
- **Both-rep is unambiguous** — each platform's opener carries its own `platform` in the button
  value; a click edits exactly that platform's canvas and row.
- **Accepted edge — overlapping refine.** `draft_body` read-modify-write is last-write-wins; two
  refines fired within one generate window can drop one edit. Benign for a single rep clicking
  buttons; no data corruption. Documented, not serialized (same posture as the accepted race in the
  single-canvas redesign).
- **Legacy null body** self-heals on first refine (step 6 §Handler).

## Out of scope (deferred)

- **Free-form NL replies.** `/api/slack/events` stays the harmless spike echo. Follow-up (not this
  scope): quiet the echo so it doesn't reply to a rep's stray thread messages.
- **Undo / version history.** No revert affordance in v1 (would need stored history).
- **"Apply to both platforms" from one click.** Each platform is refined independently.
- **Step 8 (weekly cron).** Separate remaining Phase-1 item.

## Testing

**Pure / unit (mocked):**
- `refineDraft`: prompt assembly (includes current body + the right directive for each kind;
  preserves platform length rules + the HARD anonymization rule); guardrail ordering (leak → one
  retry → redact) verified against a discriminating leak fixture; `assembleCanvasBody` applied
  (IG visual split preserved). Assert the shared guardrail helper is used by both entry points.
- `buildOpenerBlocks`: **structural** assertions — four buttons, four **distinct** `action_id`s
  (`refine:<kind>`), each `value` = `encodePlatformValue(ideaId, platform)`, correct labels. (Not a
  `JSON.stringify().toContain()` substring check — the earlier reviewer minor.)
- `handleRefine` mapping: row lookup by `(rep, idea, platform)`; null-`draft_body` self-heal path;
  missing-canvas notice path; confirmation copy incl. redaction caveat. `sca_thread_map` update asserted.

**Live-verified on prod (the real proof):**
- Draft an idea → four refine buttons appear under the opener.
- Click "Shorter" → the **same** canvas updates (shorter), interim → confirmation threads under the
  idea; no new canvas, no stub. Click "Punchier" → compounds (still shorter, now punchier).
- "Less salesy" and "Different angle" behave sensibly; anonymization holds (no real names leak).
- Both-rep: refining the LI draft leaves the IG draft untouched, and vice-versa.
- Threading stays clean (all refine messages nest under the idea; main feed unchanged).

## Build order (each independently testable)

1. **Migration + schema mirror** — add `draft_body`; `draftOnePlatform` insert persists it.
   (Column is inert until later steps read it.)
2. **`refineDraft` + shared guardrail helper** (`lib/generation.ts`) — pure, TDD.
3. **Opener buttons** (`lib/digest.ts`) — `buildOpenerBlocks` + action/kind consts; `draftOnePlatform`
   passes `ideaId`. Structural block tests.
4. **`handleRefine`** (`lib/draft.ts`) — lookup + refine + edit + persist + confirm; never-throw.
5. **Route dispatch** — `refine:` prefix in `waitUntil`.
6. **Live verification** — the prod click-through above (Trent hand-off).
