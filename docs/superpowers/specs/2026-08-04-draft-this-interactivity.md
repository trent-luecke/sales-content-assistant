# Sales Content Assistant — "Draft this" Interactivity + Draft Loop Design

**Date:** 2026-08-04
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Phase 1 build-order step:** 6 of 8
**Builds on:** [Phase 1 design spec](2026-07-29-sales-content-assistant-phase-1-design.md),
[Phase 0 findings](../spikes/phase-0-findings.md) (Spike A async-ack, Spike B Canvas-in-DM,
Spike C voice/story), and the shipped digest (step 5) whose button contract this consumes.

## Goal

When a rep clicks the **"Draft this"** button on a digest idea, the bot writes a first-draft
post **in the rep's voice with the anonymization guardrail enforced**, drops it into a Slack
**Canvas** in their DM, opens a thread inviting iteration, and records the session in
`sca_thread_map`. This is the bridge from the idea pool (steps 4-5) to the in-thread
iteration loop (step 7).

## Scope

**In scope:** the `/api/slack/interactivity` endpoint (signature verify + async-ack), the
voice-conditioned generation lib with the anonymization guardrail (regenerate-then-redact),
the source-moment read for demo ideas, the Canvas creation helper, the atomic idea-claim
(double-click safety), the thread opener (with a redaction caveat when applicable), and the
`sca_thread_map` write.

**Out of scope (deferred):** the in-thread iteration loop (step 7 — reuses `editCanvas` and
`generation` built here); the weekly cron (step 8). `editCanvas` is *built* here so the Canvas
helper is complete, but it is first exercised live in step 7.

## Inherited principles (binding)

1. Rep is the author; the AI never publishes. The Canvas draft is a starting point the rep
   copies out and posts themselves.
2. **No customer/prospect/deal specifics in generated content.** This is the highest-stakes
   surface in the whole system — the actual post. Defense in depth below.
3. Private only (rep ↔ bot DM).
4. Isolation: rep resolved fresh from the request; every read/write keyed by rep.

## Button contract (consumed — already shipped in step 5)

Slack POSTs `/api/slack/interactivity` on click with:
```json
{
  "type": "block_actions",
  "actions": [{ "action_id": "draft_this", "value": "<idea uuid>" }],
  "user": { "id": "<slack_user_id>" },
  "channel": { "id": "<dm_channel_id>" },
  "message": { "ts": "<digest_message_ts>" }
}
```
`action_id` is the constant `DRAFT_THIS_ACTION = "draft_this"` exported from `lib/digest.ts`;
`value` is the idea's uuid.

## Architecture (four focused units)

### 1. Route — `app/api/slack/interactivity/route.ts`

Thin HTTP boundary, mirroring the events route's async-ack (Spike A):

1. Read `rawBody` (text). Verify with the existing `verifySlackSignature`
   (`lib/slack/verify.ts`) using `SLACK_SIGNING_SECRET`. Invalid → `401`. This signature check
   is the security boundary (Vercel Deployment Protection stays OFF so Slack can reach the
   endpoint — per Phase 0).
2. Parse `rawBody` as `application/x-www-form-urlencoded`, read the `payload` field, `JSON.parse`
   it. **This differs from `/api/slack/events`**, which is raw JSON — interactivity payloads are
   form-encoded with a single `payload` field.
3. If `payload.type !== "block_actions"` or `payload.actions?.[0]?.action_id !== "draft_this"`,
   ack `200` and ignore (not our interaction).
4. Ack immediately with an empty `200` (Slack's 3-second rule), then
   `waitUntil(handleDraftThis(payload))` for the slow work.
5. `export const dynamic = "force-dynamic"`, `export const maxDuration = 120`.

No business logic in the route — verify, parse, ack, hand off.

### 2. Orchestration — `lib/draft.ts`

`handleDraftThis(payload): Promise<void>` — runs inside `waitUntil`; owns all failure handling
(nothing after the ack can surface an HTTP error to Slack).

1. Extract `ideaId = payload.actions[0].value`, `slackUserId = payload.user.id`,
   `channel = payload.channel.id`.
2. Resolve the rep fresh: `getProfileBySlackUser(slackUserId)`. No profile → post a soft error
   in the DM, stop.
3. **Atomically claim the idea** via `claimIdea(ideaId, repId)` (new in `lib/ideas.ts`):
   `UPDATE sca_ideas SET status='used', used_at=now() WHERE id=ideaId AND rep_id=repId AND
   status='candidate'` returning the row. Outcomes:
   - **Claimed** (row returned) → proceed.
   - **Already used** (idea exists for this rep but was not `candidate`) → look up the existing
     `sca_thread_map` row by `idea_id`, post a gentle reply ("You're already drafting this one
     👆") in that thread (fall back to a channel-level reply if no map row), stop.
   - **Not found / wrong rep** (no matching idea) → post a soft error, stop. This also enforces
     cross-rep isolation: a `value` pointing at another rep's idea cannot be claimed.
4. **Load the source moment:** if the claimed idea is `source='demo'` with a `meetingId` in
   `source_ref`, call `readDemoMoment(meetingId)` (new in `lib/mining.ts`) → a `DemoMoment`
   (`{ title, repTurns, speakers, repFirstName }`; see below). Otherwise (organic, or no
   `meetingId`, or the meeting isn't found) the moment is `null`. Generation derives the
   forbidden-name list from this `DemoMoment` via its own `forbiddenNames` helper.
5. **Generate:** `generateDraft(idea, profile, sourceMoment)` → `{ body, wasRedacted }`.
6. **Create the Canvas:** `createCanvasInDM(channel, title, body)` → `canvasId`. `title` is
   derived from the idea's `hook` (a short label); `body` is the generated post.
7. **Post the thread opener** (its `ts` becomes the thread parent). Base text:
   "First cut's in the canvas above — tell me what to change and I'll rework it." When
   `wasRedacted`, append: "⚠️ Heads up — I had to redact a name to keep this anonymous, so one
   phrase might read a little awkwardly. Worth a quick look before you post."
8. **Write `sca_thread_map`:** `{ rep_id, slack_channel: channel, thread_ts, canvas_id, idea_id }`.

**Failure handling (steps 4-8):** wrap in try/catch. On a caught error: **release the claim**
(`setIdeaStatus(ideaId, "candidate")`) so the rep can retry, post a friendly DM ("Something went
wrong drafting that — try again in a sec"), and log. Claiming early prevents double-drafting;
releasing on failure prevents a stranded `used` idea with no draft.

### 3. Generation — `lib/generation.ts`

**Pure helpers (unit-tested):**
- `forbiddenNames(moment: DemoMoment): string[]` — union of names parsed from the meeting title
  and the distinct **non-rep** speaker labels in the chunks; excludes the rep's own first name.
  Speaker labels are the reliable signal (the actual people in the room).
- `redact(text: string, names: string[]): string` — replace each forbidden name (case-insensitive,
  word-boundary, including a trailing possessive `'s`) with a single neutral token `"[someone]"`.
  The fail-safe after regeneration. Role-agnostic token chosen deliberately: the leaked entity may
  be a person, colleague, or company, and redaction is the rare last resort with a human reviewing
  before posting.
- `buildDraftPrompt(idea, profile, moment: DemoMoment | null): string` — assembles the
  voice-conditioned prompt: the rep's `voice_traits` (names + descriptions + example lines),
  `background`, `angle`, `admired_post`, the idea's `hook` + `rationale`, and — for demo ideas —
  the source moment's rep turns. Always includes the hard anonymization rule (never name a
  customer/prospect/company/deal; render as an anonymized pattern).

**I/O driver:**
- `generateDraft(idea, profile, moment): Promise<{ body: string; wasRedacted: boolean }>` — owns
  the guardrail loop, model `anthropic("claude-sonnet-5")`:
  1. `generateText(buildDraftPrompt(idea, profile, moment))`.
  2. `const leaked = containsAny(body, forbidden)` where `forbidden = moment ? forbiddenNames(moment) : []`.
  3. If leaked → regenerate once, appending an explicit instruction naming the leaked term and
     telling the model to remove it.
  4. If it still leaks → `body = redact(body, forbidden)`, set `wasRedacted = true`.
  5. Return `{ body, wasRedacted }`.

  For organic ideas (`moment === null`) the forbidden list is empty and the check is a no-op —
  the inputs (`hook`/`rationale`/profile) are already anonymized.

### 4. Canvas helper — `lib/slack/canvas.ts`

Thin wrappers over the Spike-B-proven mechanics:
- `createCanvasInDM(channel: string, title: string, markdown: string): Promise<string>` —
  `conversations.canvases.create` (canvas attached to the DM so it renders inline), returns the
  `canvas_id`.
- `editCanvas(canvasId: string, markdown: string): Promise<void>` — `canvases.edit` with a
  full-document `replace` operation. **Not called in step 6**; built now so the Canvas home is
  complete, first exercised live in step 7.

## New source-moment read — `lib/mining.ts` addition

`readDemoMoment(meetingId: string): Promise<DemoMoment | null>` where
`DemoMoment = { title: string; repTurns: string[]; speakers: string[]; repFirstName: string }`.
Reuses the existing `ragReadClient` + chunk-reading pattern from `readRepDemos`: one query for
the meeting (title + rep_name), one for its chunks (speaker + text, ordered by `chunk_index`).
Returns `repTurns` (the rep's own turns, for grounding) and the distinct `speakers` (for the
forbidden-name list). `null` if the meeting is not found.

## Data model

No schema change. Writes one `sca_thread_map` row per successful draft:
`{ rep_id, slack_channel, thread_ts, canvas_id, idea_id }` (unique on `(slack_channel, thread_ts)`).
Flips the claimed idea to `status='used'`, `used_at=now()` (released back to `candidate` on failure).

## New env / config

No new env vars. Consumes existing `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`,
`SCA_SUPABASE_*`, `RAG_SUPABASE_*`. **Slack app config (human step):** set the app's
Interactivity Request URL to `<deploy>/api/slack/interactivity` and ensure the bot scopes include
`canvases:write` (and `conversations.canvases`), verified in the live pass.

## Testing

**Unit (pure, mocked — no secrets):**
- `forbiddenNames` — title names ∪ non-rep speakers, excludes the rep's own name.
- `redact` — removes names + possessive `'s`, case-insensitive; leaves clean text untouched;
  uses the `[someone]` token.
- `buildDraftPrompt` — includes voice traits + hook/rationale + anonymization rule; includes the
  moment's rep turns for demo ideas, omits them for organic.
- `claimIdea` outcome mapping — claimed / already-used / not-found → correct branch (DB mocked).
- **Anonymization guardrail (mandated):** feed `generateDraft` a moment containing a known name,
  mock the model to leak on the first call and (a) recover on regeneration, and (b) still leak so
  `redact` fires — assert the returned `body` never contains the name and `wasRedacted` is correct.

**Integration (live deploy, Phase-0 pattern):** generate a fresh digest, click "Draft this" on a
demo idea → a Canvas with a voice-matched, anonymized draft appears in the DM; the thread opener
posts; a `sca_thread_map` row is written with the right `idea_id`/`canvas_id`/`thread_ts`; confirm
no customer names in the draft on real transcript data. Click the same button again → gentle
"already drafting" reply, no second Canvas.

## Risks

- **Anonymization leakage (highest stakes)** — this is the real post. Defense in depth: prompt-level
  rule + demo turns pre-scoped to the rep's own speech + second-pass `containsAny` on the output +
  regenerate-once + redact fail-safe + the rep reviews before posting. The `wasRedacted` caveat in
  the thread flags the one path where phrasing may be rough.
- **Async path swallows errors** — `handleDraftThis` runs post-ack, so failures can't 500 to Slack;
  mitigated by the try/catch that releases the claim and posts a friendly DM (the rep always gets a
  signal, never a silent nothing).
- **Double-click / rapid clicks** — the conditional `claimIdea` (`WHERE status='candidate'`) is the
  atomic guard; only one click can claim, the rest short-circuit.
- **Slack Canvas scopes/config** — `canvases:write` must be granted and the Interactivity URL set;
  caught in the live pass, not unit tests.
- **maxDuration** — RAG read + up to two model calls + Canvas create must fit 120s; generous at one
  rep. Revisit if drafts time out.

## Build order (each independently testable)

1. `lib/generation.ts` pure helpers (`forbiddenNames`, `redact`, `buildDraftPrompt`) + tests.
2. `generateDraft` I/O driver + the guardrail integration test (mocked model).
3. `readDemoMoment` in `lib/mining.ts`.
4. `claimIdea` in `lib/ideas.ts` + outcome test.
5. `lib/slack/canvas.ts` (`createCanvasInDM`, `editCanvas`).
6. `lib/draft.ts` orchestration (`handleDraftThis`).
7. `app/api/slack/interactivity/route.ts`.
8. Live integration verification (Slack app config + click-through).
