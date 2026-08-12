# Sales Content Assistant — Threaded Drafting & Self-Identifying Canvas

**Date:** 2026-08-12
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Builds on:** the [single-canvas-per-platform redesign](2026-08-07-single-canvas-per-platform-design.md) (shipped, live). Reuse-in-place, claim-at-commit, and the replace-confirm flow are unchanged by this work.

## Why this work

Two problems surfaced during live verification of the single-canvas redesign:

1. **The canvas title goes stale.** A rep reuses one canvas per platform, edited in place. But **Slack has no API to rename a canvas** — `canvases.edit` accepts only `canvas_id` + document-content `changes` (verified against `@slack/web-api`: `CanvasesEditArguments` has no `title` field); the title is settable only at `conversations.canvases.create`. So after a Replace, the canvas still shows the *first* idea's title (`"LI: <old hook>"`) over the *new* idea's body. You can't tell what you're looking at.
2. **The DM feed sprawls.** Every "Draft this" spawns new top-level messages (the platform question, the drafting note, the opener, the replace-confirm, the retry). They pile up in the main channel body, disconnected from the idea that spawned them.

Both are "what am I looking at?" problems. The fix makes each draft self-identifying and self-contained.

## Goal

- A reused canvas **identifies its current idea from its own content** (a hook heading at the top), with a **stable, platform-level title** that never needs renaming.
- Drafting is **nested under the idea that started it**: the weekly digest posts one message per idea, and every bot response to "Draft this" is a threaded reply under that idea's message. The main feed stays quiet.

## Scope

**In scope:**
- **Part A — Self-identifying canvas:** stable per-platform canvas title; the current idea's hook rendered as an H1 at the top of the canvas body (create *and* every reuse-edit); opener copy updated to stop leaning on the old hook-bearing title.
- **Part B — Threaded drafting:** the weekly digest split into a header message + one top-level message per idea; every draft-related bot message threaded under the clicked idea's message; the thread root derived from the interaction payload.

**Out of scope (deferred, unchanged):**
- **Step 7 (iteration loop).** Not built here. When built, mapping a rep's thread reply back to a specific draft will need the idea-thread root persisted (see "Step-7 dependency" below). This spec deliberately does **not** add that column now (YAGNI, and it keeps this change migration-free).
- **Reuse model, claim-at-commit, replace-confirm, the removed Done/delete surface** — all unchanged.

## Inherited principles (binding)

1. Rep is the author; the AI never publishes.
2. **No customer/prospect/deal specifics in generated content** — the `generateDraft` anonymization guardrail is unchanged.
3. Private only (rep ↔ bot DM); rep resolved fresh per request.
4. **Post-ack invariant:** every interactivity handler runs inside `waitUntil` and never throws.
5. **Utilization-tracker data survives:** each draft still inserts an `sca_thread_map` row; nothing is deleted.
6. **No delete-based Slack calls** anywhere (no `canvases.delete` / `files.delete`).

## Key decisions (resolved in brainstorm, 2026-08-12)

1. **Canvas stays the draft surface.** Threading organizes the *control messages* around the canvas; the draft itself remains the editable one-per-platform canvas at the top of the DM. (Rejected: inlining the draft text into the thread — throws away the canvas UX; and canvas-plus-thread-copy — two sources of truth.)
2. **Stable platform title + hook-as-H1.** The title becomes `"<Platform label> draft"` (e.g. `"LinkedIn draft"`), set once and never changed. Identity comes from an H1 heading (the idea's hook) at the top of the body, which refreshes on every full-document replace.
3. **Digest = header + one top-level message per idea.** Each idea message is its own thread root. (Rejected: no-header variant loses framing; ideas-threaded-under-a-header prevents a clean second level of nesting since Slack has no nested threads.)
4. **Thread root derived from the payload, no schema migration.** `rootTs = message.thread_ts ?? message.ts`. The `sca_thread_map` row still keys on the opener reply's own ts (unique), so the `unique(slack_channel, thread_ts)` constraint is unaffected.
5. **Both-reps nest both drafts in the one idea thread.** Step-7 disambiguation is deferred; single-platform reps (the majority) never hit ambiguity.

## Data model

**No schema migration.** No columns added, no constraints changed.

- `sca_thread_map.thread_ts` continues to hold **the opener reply's own ts** (a message inside the idea thread). Because each opener reply has a unique ts, `unique(slack_channel, thread_ts)` still holds even when a Both-rep has two drafts under one idea thread.
- Every draft still inserts one `sca_thread_map` row `{ rep_id, slack_channel, thread_ts, canvas_id, idea_id, platform }`. The reuse lookup (`currentCanvasId`, keyed on `(rep, platform)`) is unchanged.

**Step-7 dependency (documented, not built):** a rep's in-thread reply carries `thread_ts = rootTs` (the idea message), which is *not* what `sca_thread_map.thread_ts` stores. When step 7 is built it will need the idea-thread root persisted (e.g. a nullable `root_ts` column) to map replies → draft, plus per-platform disambiguation for Both. Rows written before that migration simply won't be iterable — acceptable for a deferred feature.

## Architecture

### Part A — Self-identifying canvas

**1. Stable title — `lib/generation.ts` / `lib/slack/canvas.ts` callers in `lib/draft.ts`.**
The canvas is created with a stable, platform-level title instead of the hook-bearing `canvasTitle(platform, hook)`. New pure helper:

```
canvasName(platform): string   // e.g. "LinkedIn draft" / "Instagram draft"
```

`draftOnePlatform` passes `canvasName(platform)` to `createCanvasInDM`. `canvasTitle` (the `"LI: <hook>"` builder) is no longer used for canvas creation; remove it if it has no remaining callers after this change (verify — the opener copy also used it).

**2. Hook heading in the body — `lib/generation.ts`, applied in `lib/draft.ts`.**
`generateDraft` already returns `body = assembleCanvasBody(text, platform)`. A new pure helper prepends the idea's hook as an H1 so the canvas self-identifies:

```
canvasDocument(hook, body): string   // returns `# ${hook}\n\n${body}`
```

`draftOnePlatform` builds `const document = canvasDocument(idea.hook, body)` and passes `document` to **both** `createCanvasInDM` and `editCanvas`. Because the reuse path does a full-document `replace`, the heading updates to the current idea on every Replace — resolving the stale-title confusion.

**3. Opener copy — `lib/digest.ts` (`buildOpenerBlocks`).**
The opener no longer references the (now-generic) canvas title with the hook. It names the platform canvas plainly and points the rep at the thread to iterate — e.g. *"Your {LinkedIn} draft is in the canvas at the top. Reply here to tell me what to change."* The `wasRedacted` caveat behavior is unchanged.

### Part B — Threaded drafting

**4. Per-idea digest delivery — `lib/digest.ts` (`assembleAndDeliver` + builders).**
Replace the single combined `buildDigestBlocks(ideas)` message with:
- one **header** message (the "Here are a few things worth saying this week" line), and
- **one top-level message per idea**, each carrying the idea's hook + rationale + a "Draft this" button with the idea id as value (the existing `DRAFT_THIS_ACTION` contract is unchanged).

Pure builders (unit-tested): a header-blocks builder and a single-idea-blocks builder (hook + rationale section + one "Draft this" actions block). Each idea message's ts becomes that idea's thread root. `sca_digests` logging records the same `idea_ids`; `message_ts` stores the header message ts (delivery-log only — no behavior depends on it).

**5. Thread-root derivation + threading — `lib/draft.ts`.**
Every handler derives the idea-thread root from its interaction payload:

```
rootTs = payload.message.thread_ts ?? payload.message.ts
```

- First "Draft this" click (on a top-level idea message): `message.thread_ts` is absent → `rootTs = message.ts` (the idea message).
- Any later click (platform-choice, replace-confirm — themselves replies in the thread): `message.thread_ts` is present → `rootTs` is the same idea message.

`rootTs` is threaded through the post chain (`claimAndDraft` → `commitOnePlatform` → `draftNow`, and `handleDraftThis`'s platform-choice post), and **every** bot `postMessage` in the draft flow includes `thread_ts: rootTs`:
- the platform-choice question (Both),
- the "drafting…" interim note,
- the opener (posted fresh, or via the reused interim/confirm message which is already in-thread),
- the replace-confirm prompt,
- the retry offer.

`handleDraftReplaceConfirm` continues to reuse the confirm message's ts as the drafting-note→opener (already a reply, so it stays in-thread) — it needs no new post. Soft-error/nudge posts (`safePost`) thread under `rootTs` too, for consistency.

The `sca_thread_map` insert is unchanged: `thread_ts` = the opener reply's own ts.

**6. Route — `app/api/slack/interactivity/route.ts`.**
No routing changes. The same `action_id`s dispatch to the same handlers; only the handlers' posting targets (thread vs top-level) change. `maxDuration = 120` unchanged.

## Testing

Same split the repo uses: pure builders unit-tested (Vitest); Slack/DB I/O in `lib/draft.ts` verified by `tsc` + a live pass.

**Unit (pure, mocked) — `lib/generation.ts` + `lib/digest.ts`:**
- `canvasName(platform)` → `"LinkedIn draft"` / `"Instagram draft"`.
- `canvasDocument(hook, body)` → body prefixed with `# <hook>` and a blank line; existing body preserved verbatim.
- Per-idea digest builders: the header builder returns the framing section; the single-idea builder returns hook + rationale + exactly one "Draft this" button carrying the idea id and `DRAFT_THIS_ACTION`.
- `buildOpenerBlocks` (updated copy): names the platform, no longer emits the `"LI:/IG: <hook>"` title string, still gates the redaction caveat on `wasRedacted`, still has no actions block.
- Remove/replace any assertions tied to the old combined-digest or hook-bearing-title behavior.

**Live-verified on prod (the real proof):**
- Draft an idea → its canvas title reads `"LinkedIn draft"` and the body opens with the idea's hook as a heading.
- Replace with a new idea → the **same** canvas updates: the heading now shows the **new** hook, the body is the new draft, the title is unchanged — no stale title, no new canvas, no stub.
- Digest day: the DM shows a header + one message per idea. Clicking "Draft this" on an idea nests the drafting note, opener, and any replace-confirm/retry **as replies under that idea's message**; the main feed stays clean.
- Both-rep: the platform question and both drafts nest under the one idea thread; the two canvases (one LI, one IG) sit at the top, each self-identifying.

## Risks

- **Payload shape for `rootTs`.** Relies on `message.thread_ts`/`message.ts` being present on block-action payloads. True for messages the bot posts (button clicks always carry `message`/`container`). Fallback: if both are absent, thread nothing (post top-level) rather than throw — preserves the post-ack invariant. Verified live.
- **Digest split changes a live surface.** The weekly digest message shape changes from one message to N; `sca_digests.message_ts` semantics narrow to "header ts." Low impact (delivery log). Re-verified live.
- **Step-7 iteration on the new thread model.** Replies land on `rootTs`, which this spec doesn't persist. Documented as a step-7 dependency; benign until step 7 exists.
- **Both-rep in-thread ambiguity.** Two drafts share one idea thread; step-7 must disambiguate later. Single-platform reps are unaffected.

## Build order (each independently testable)

1. **Part A — canvas identity** (`lib/generation.ts` helpers `canvasName`/`canvasDocument` + tests; `lib/draft.ts` uses them in `draftOnePlatform`; `lib/digest.ts` opener copy + test). Independently shippable and resolves the live stale-title confusion first.
2. **Part B — per-idea digest** (`lib/digest.ts` header + single-idea builders; `assembleAndDeliver` posts header + one message per idea; tests).
3. **Part B — threading** (`lib/draft.ts` derive `rootTs`, thread it through every draft-flow post).
4. **Live verification** (canvas identity on reuse; per-idea threads; Both-rep nesting; clean feed).
