# Sales Content Assistant — Multi-Platform Drafting Design

**Date:** 2026-08-05
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Phase 1 build-order step:** NEW scope (layers onto step 6; makes the data model step-7-ready)
**Builds on:** [Phase 1 design spec](2026-07-29-sales-content-assistant-phase-1-design.md),
[the shipped "Draft this" interactivity + draft loop (step 6)](2026-08-04-draft-this-interactivity.md)
whose flow, generation lib, claim, and `sca_thread_map` write this extends.

## Goal

TeamBuildr reps post to **LinkedIn and/or Instagram**. Today the draft loop produces ONE
draft with no platform awareness — it reads like LinkedIn and isn't tailored for Instagram
(image-heavy, wants concise copy + a visual). This feature makes drafting platform-aware:
draft in the shape of the platform(s) a rep actually uses, ask which platform only when the
rep has both, and — for Instagram — include a text visual-concept suggestion. It also adds the
one column (`sca_thread_map.platform`) that lets the not-yet-built iteration loop (step 7)
inherit platform-aware iteration for free.

## Scope

**In scope:** a post-click platform-choice interstitial for both-channel reps (new
`draft_platform` action); a `platform` argument threaded through `generateDraft` /
`buildDraftPrompt` with per-platform format instructions; a tightened "no hashtags, no emoji"
rule on **both** platforms; an Instagram-only "Visual idea" section assembled into the canvas;
the `sca_thread_map.platform` column; the "Both" fan-out (one claim → two independent draft
sessions); and the refactor of `lib/draft.ts` onto a shared `claimAndDraft` spine.

**Out of scope (deferred):**
- **Grabbing a real marketing asset** (a DAM / Drive / digital-asset-library integration).
  v1 gives *text* visual concepts only. This is a separate, later phase.
- **Step 7 (in-thread iteration loop).** Not co-built. This feature only makes the data model
  step-7-ready (the `platform` column) so step 7 iterates each draft at the right length.
- **Utilization tracker** (a monthly per-rep draft-count Google Sheet for management). Its data
  foundation lands here for free — every draft writes an `sca_thread_map` row with `rep_id`,
  `created_at`, and now `platform` — but the reporting job is its own later spec.

## Inherited principles (binding)

1. Rep is the author; the AI never publishes. The Canvas is a starting point the rep copies out.
2. **No customer/prospect/company/deal specifics in generated content.** Highest-stakes surface.
   The anonymization guardrail is unchanged and platform-independent — it wraps every draft
   (caption and, for Instagram, the visual-concept text) regardless of platform.
3. Private only (rep ↔ bot DM).
4. Isolation: rep resolved fresh per request; every read/write keyed by rep.

## Key decisions (resolved in brainstorm, 2026-08-05)

1. **Both-channel reps are asked per-post** (approach B), not auto-generated both (A). A
   both-channel rep doesn't post every idea to both places; asking keeps output intentional and
   canvas clutter low. Single-channel reps are never asked.
2. **"Both" produces two separate canvases + two threads** from a single claim — a clean 1:1
   (one canvas = one thread = one platform) so step-7 iteration is never ambiguous.
3. **The Instagram visual idea lives in a delimited canvas section**, not the thread message, so
   step 7 can iterate it in place and it persists with the draft.
4. **Instagram draft shape:** tight (~40–110 words), payload front-loaded into the first line,
   hook → 1–2 beats → light close; LinkedIn keeps ~120–250 words, hook → insight → takeaway.
5. **Zero hashtags and zero emoji in the draft body on BOTH platforms** (reps add them by hand).
   This tightens today's LinkedIn rule, which permitted them if the rep's examples did.
6. **Ship multi-platform now; add `sca_thread_map.platform`; do not co-build step 7.**
7. **The digest "Draft this" button is unchanged** (`draft_this`, `value = idea uuid`). All
   platform logic happens after the click.

## Button contracts

**Unchanged (from step 5/6):** the digest button — `action_id: "draft_this"`, `value: "<idea uuid>"`.

**New:** the platform-choice buttons, posted only for both-channel reps.
```json
{
  "type": "block_actions",
  "actions": [{ "action_id": "draft_platform", "value": "<idea uuid>|<selection>" }],
  "user": { "id": "<slack_user_id>" },
  "channel": { "id": "<dm_channel_id>" }
}
```
`selection ∈ {"instagram", "linkedin", "both"}`. `action_id` is a new constant
`DRAFT_PLATFORM_ACTION = "draft_platform"` (exported from `lib/digest.ts` alongside
`DRAFT_THIS_ACTION`). The `<idea uuid>|<selection>` encoding is parsed by a pure helper (uuids
contain no `|`).

## Architecture

### 1. Route — `app/api/slack/interactivity/route.ts`

Unchanged HTTP boundary (verify signature → parse form-encoded `payload` → ack `200` → dispatch
in `waitUntil`), extended to dispatch a second action:
- `action_id === "draft_this"` → `waitUntil(handleDraftThis(payload))` (as today).
- `action_id === "draft_platform"` → `waitUntil(handleDraftPlatform(payload))` (new).

`maxDuration = 120` stays. No business logic in the route.

### 2. Orchestration — `lib/draft.ts`

Refactored onto a shared spine so single-channel drafting and platform-picked drafting run
identical logic; only the platform list differs. All three functions run post-ack inside
`waitUntil` and **never throw**.

**`handleDraftThis(payload)`** — resolves the rep, then branches on `profile.channels`:
- **Exactly one channel** (or **empty** → default `["linkedin"]`, never a dead end) →
  `claimAndDraft(ideaId, profile, [thatPlatform])`. Same experience reps have today.
- **Both channels** → post the platform-choice message (see below). **Does not claim** — the
  rep hasn't committed yet; claiming here would burn an idea a browsing rep abandons.

**`handleDraftPlatform(payload)`** (new) — parses `ideaId` + `selection`, maps `selection` to a
platform list (`"both"` → `["linkedin","instagram"]`, else `[selection]`), then
`claimAndDraft(ideaId, profile, platforms)`. This is the real commitment point; the claim
happens here.

**`claimAndDraft(ideaId, profile, platforms[])`** (shared spine):
1. **Atomically claim** via `claimIdea(ideaId, repId)` (unchanged). Outcomes as today:
   - *already_used* → gentle reply in the existing thread ("You're already drafting this one 👆");
   - *not_found* → soft error;
   - *claimed* → proceed. (This is also the button-spam guard: a second platform pick on the
     same idea returns *already_used*.)
2. **Post one interim ack** ("✍️ Drafting your {platform(s)}…"), whose `ts` becomes the thread
   parent for the first platform.
3. **Read the demo moment once** (`readDemoMoment`, best-effort → `null` on failure/organic),
   shared across all platforms for this idea.
4. **Draft each platform as an isolated sub-task** — for "Both", run the two `generateDraft`
   calls **concurrently** (`Promise.all`) to stay inside `maxDuration`. Each platform:
   `generateDraft(idea, profile, moment, platform)` → `createCanvasInDM` → opener message
   (its `ts` = that session's `thread_ts`; the first platform reuses the interim message,
   subsequent platforms post fresh) → insert a `sca_thread_map` row carrying `platform`.
5. **Failure handling** (post-ack invariant):
   - **All platforms fail** → release the claim (`setIdeaStatus(ideaId,"candidate")`), one generic
     error; the idea is fully retryable.
   - **Partial success (Both)** → **keep the claim** (a real draft exists; releasing would orphan
     it), land the successful canvas/thread, and post a targeted note ("Your LinkedIn draft's
     ready 👆 — I hit a snag on the Instagram one, click Draft this again to retry it").

### 3. Platform-choice message — `lib/digest.ts` (pure builder)

`buildPlatformChoiceBlocks(ideaId): KnownBlock[]` — a section with the copy
**"Which platform(s) will this be posted on?"** and an actions block of three buttons
(**Instagram / LinkedIn / Both**), each `action_id: "draft_platform"`,
`value: "<ideaId>|<selection>"`. Pure and unit-tested, mirroring `buildDigestBlocks`.

The choice message's buttons persist after a pick (Slack doesn't auto-remove them); this is
acceptable because the claim guards double-drafting. Stripping the buttons after a pick is
optional polish, left out of v1.

### 4. Generation — `lib/generation.ts`

**Signature change:** `generateDraft(idea, profile, moment, platform)` and
`buildDraftPrompt(idea, profile, moment, platform)`, where `platform ∈ {"linkedin","instagram"}`.

**Unchanged and platform-independent:** the voice-traits / background / angle / admired-post
sections, the demo-moment block, and the entire guardrail
(`forbiddenNames → containsAny → regenerate once → redact`). The guardrail runs over the whole
raw model output (caption + any visual text) before any splitting, so the visual concepts are
anonymized too.

**What changes by platform (the format instruction only):**
- **Both platforms:** "No hashtags. No emoji. The rep will add those by hand if they want."
  (Replaces today's "no hashtags unless the rep's examples use them.")
- **LinkedIn:** ~120–250 words; strong opening line; hook → anonymized insight → takeaway.
- **Instagram:** tight (~40–110 words); payload lands in the **first line** (IG truncates ~125
  chars before "…more"); hook → 1–2 beats → light close; whitespace-friendly. **Plus** a
  visual-concept instruction: after the caption, emit a sentinel line `===VISUAL===` then 1–2
  concrete, anonymized visual ideas.

**Canvas assembly stays inside `generation.ts`** — `generateDraft` still returns
`{ body, wasRedacted }`, where `body` is **canvas-ready markdown** so `lib/draft.ts` stays dumb
(writes `body` to the canvas unchanged):
- **LinkedIn** → `body` = caption, as today.
- **Instagram** → after the guardrail runs, a pure helper splits the output on `===VISUAL===`
  and assembles `body` = caption + a divider + the plain-text label
  **"Visual idea — not part of your caption"** + the concepts. If the sentinel is absent (model
  didn't comply), the whole output is treated as the caption and the visual section is omitted —
  graceful, never errors.

Pure helpers extracted for unit tests: the `===VISUAL===` split and the canvas assembly.

## Data model

**One schema change:**
```sql
alter table sca_thread_map add column platform text
  check (platform in ('linkedin','instagram'));
```
- **Nullable, no default.** Pre-migration rows keep `platform = null`; step 7 treats `null` as
  `'linkedin'` (every draft to date has been LinkedIn-shaped). New rows always write an explicit
  platform.
- **Unique constraint unchanged** — still `(slack_channel, thread_ts)`. A "Both" pick writes two
  rows with the same `idea_id` but different `thread_ts` (two opener messages), so no collision.
  `idea_id` was never unique and stays non-unique.
- **No `platform` on `sca_ideas`** — an idea isn't platform-specific; the draft *session* is.

Each successful draft flips the claimed idea to `used` (released to `candidate` only when *all*
platforms fail) and writes one `sca_thread_map` row per platform:
`{ rep_id, slack_channel, thread_ts, canvas_id, idea_id, platform }`.

## New env / config

None. Consumes the same env and Slack scopes as step 6. The Slack app's Interactivity Request
URL already points at `/api/slack/interactivity`; the new `draft_platform` action arrives on the
same endpoint, so no Slack config change is required.

## Testing

Same split the repo uses: pure logic unit-tested (Vitest); Slack/RAG/AI I/O verified on one live
Vercel deploy.

**Unit (pure, mocked — no secrets):**
- `buildDraftPrompt` per platform — LinkedIn has the length/structure instruction + the zero
  hashtags/emoji rule and **no** visual instruction; Instagram has the tight-format instruction +
  the zero rule + the `===VISUAL===` visual instruction. Both include the unchanged anonymization
  rule and voice sections.
- The `===VISUAL===` split + canvas assembly helper — caption-only (LinkedIn) vs caption + visual
  section (Instagram); missing-sentinel graceful path (whole output = caption, no visual section).
- Button-value parse — `"<ideaId>|<selection>"` → `{ ideaId, selection }`; rejects malformed input.
- Platform-selection decision — single channel → `[that]`; empty channels → `["linkedin"]`;
  `"both"` → `["linkedin","instagram"]`; `"instagram"`/`"linkedin"` → `[that]`.
- `buildPlatformChoiceBlocks` — correct copy, three buttons, correct `action_id` and encoded values.

**Integration (live deploy):** fire a digest via `/api/digest/generate`; as a **both-channel**
rep click "Draft this" → the "Which platform(s)…" message appears; exercise **Instagram**,
**LinkedIn**, and **Both**; confirm the right canvases (IG shows the "Visual idea" section, no
hashtags/emoji anywhere), the opener threads, and the `sca_thread_map` rows with correct
`platform` values (two rows for "Both"). As a **single-channel** rep, confirm no question is
asked and the draft matches that platform's shape. Re-click to confirm the *already_used* nudge.

## Risks

- **Anonymization leakage (highest stakes)** — unchanged guardrail, now also covering the
  Instagram visual-concept text (guardrail runs before the split). No new exposure surface.
- **"Both" partial failure** — mitigated by isolated per-platform sub-tasks: total failure
  releases the claim; partial success keeps it and reports the gap honestly rather than dropping
  a draft silently.
- **`maxDuration` on "Both"** — one moment-read + two generations (each up to 2 model calls) +
  two canvas creates. Mitigated by reading the moment once and running the two generations
  concurrently. Revisit if "Both" drafts time out.
- **Model ignores `===VISUAL===`** — handled by the graceful fallback (no visual section rather
  than a broken canvas).
- **Deferred-choice claim window** — claiming at the platform pick (not at `draft_this`) means an
  idea a both-channel rep never picks stays `candidate` and can resurface in a later digest. This
  is the intended behavior (don't burn un-drafted ideas), not a bug.

## Build order (each independently testable)

1. Migration: `sca_thread_map.platform` column (+ update `db/schema.sql`).
2. `lib/generation.ts` — `platform` param on `buildDraftPrompt` (per-platform instructions + zero
   hashtags/emoji rule) and the `===VISUAL===` split + canvas-assembly pure helpers, with tests.
3. `generateDraft` — thread `platform` through; concurrent-safe; return canvas-ready `body`.
4. `lib/digest.ts` — `DRAFT_PLATFORM_ACTION` + `buildPlatformChoiceBlocks` + value-encode/parse
   helpers, with tests.
5. `lib/draft.ts` — refactor to the `claimAndDraft` spine; add `handleDraftPlatform`; extend
   `handleDraftThis` with the channel branch; the "Both" fan-out + partial-failure handling.
6. `app/api/slack/interactivity/route.ts` — dispatch `draft_platform`.
7. Live integration verification (digest → both-channel click-through → single-channel → re-click).
