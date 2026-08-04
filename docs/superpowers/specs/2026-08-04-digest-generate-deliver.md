# Sales Content Assistant — Digest Generate + Deliver Design

**Date:** 2026-08-04
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Phase 1 build-order step:** 5 of 8
**Builds on:** [Phase 1 design spec](2026-07-29-sales-content-assistant-phase-1-design.md),
Plan 1 (foundation + mining), Plan 2 (onboarding), pool refill (`/api/pool/refill`).

## Goal

Deliver a digest of the rep's top candidate ideas as a single Slack DM with per-idea
"Draft this" buttons, and record the delivery. This is the bridge between the idea pool
(already filled by pool refill) and the drafting loop (step 6).

## Scope

**In scope:** selecting top candidates, formatting a Block Kit message, posting it to the
rep's bot DM, recording a `sca_digests` row, and defining the button contract consumed by
the interactivity endpoint.

**Out of scope:** the interactivity endpoint itself (step 6), the iteration loop (step 7),
the weekly cron (step 8), any scoring/ranking enhancements beyond what `selectTopCandidates`
already does (score desc).

## Route

`POST /api/digest/generate`

- **Auth:** `Authorization: Bearer $SCA_INTERNAL_KEY` (same pattern as `/api/pool/refill`).
- **Body:** `{ slackUserId: string }`.
- **Behavior:** Resolves the profile from `slackUserId`, requires `status: "active"`.
  Calls `assembleAndDeliver(profile)`. Returns summary JSON.
- **Responses:**
  - `200` `{ repId, ideaCount, messageTs }` — digest sent (or `messageTs: null` if pool
    was empty and no DM was sent).
  - `400` — bad JSON or missing `slackUserId`.
  - `401` — missing/wrong `SCA_INTERNAL_KEY`.
  - `404` — no profile for that Slack user.
  - `409` — profile exists but `status !== "active"`.

## Digest assembly (`lib/digest.ts`)

`assembleAndDeliver(profile: Profile): Promise<{ ideaCount: number; messageTs: string | null }>`

1. `selectTopCandidates(profile.id, 3)` — reuses existing `lib/ideas.ts`.
2. If zero candidates → return `{ ideaCount: 0, messageTs: null }`. No DM sent, no digest
   recorded. The route surfaces this to the caller so they know the pool is dry.
3. `buildDigestBlocks(ideas)` — pure function (unit-tested), produces Block Kit blocks.
4. `conversations.open({ users: profile.slack_user_id })` → gets/creates the bot DM channel.
5. `chat.postMessage({ channel, blocks, text })` — `text` is a plain-text fallback for
   push notifications (e.g. "You have 3 content ideas ready").
6. Insert into `sca_digests`: `{ rep_id: profile.id, idea_ids: ideas.map(i => i.id), message_ts }`.

## Block Kit message format

A single message with this structure:

```
[section]   "Here are a few things worth saying this week."

[section]   *<hook>*\n<rationale>
[actions]   [ Draft this ]     action_id="draft_this"  value=<idea_id>

[divider]

[section]   *<hook>*\n<rationale>
[actions]   [ Draft this ]     action_id="draft_this"  value=<idea_id>

[divider]   (only between ideas, not after the last)

[section]   *<hook>*\n<rationale>
[actions]   [ Draft this ]     action_id="draft_this"  value=<idea_id>
```

Each idea is a `section` block (hook bold, rationale plain) followed by an `actions` block
with a single `button` element. Dividers separate ideas but do not trail the last one.

## Button contract (consumed by step 6: interactivity endpoint)

When a rep clicks "Draft this," Slack POSTs to `/api/slack/interactivity` with:

```json
{
  "type": "block_actions",
  "actions": [{
    "action_id": "draft_this",
    "value": "<idea uuid>"
  }],
  "user": { "id": "<slack_user_id>" },
  "channel": { "id": "<dm_channel_id>" },
  "message": { "ts": "<digest_message_ts>" }
}
```

The interactivity endpoint (step 6, out of scope here) will:
1. Resolve the rep from `user.id`.
2. Load the idea from `value`.
3. Mark the idea `used` via `setIdeaStatus`.
4. Generate a voice-conditioned first draft (anonymization guardrail enforced).
5. Create a Canvas in the DM, open a thread, write `sca_thread_map`.

This plan only needs the button to carry `action_id: "draft_this"` and `value: <idea_id>`.

## Lib structure

- **`lib/digest.ts`** (new) — `buildDigestBlocks` (pure, unit-tested) and
  `assembleAndDeliver` (Slack + DB I/O, integration-tested).
- **`lib/slack/client.ts`** (existing) — already exports the `WebClient` instance as
  `slack`. The digest calls `slack.conversations.open` and `slack.chat.postMessage` directly.
- **`app/api/digest/generate/route.ts`** (new) — thin route: auth, validate, resolve
  profile, call `assembleAndDeliver`, return result.

## Testing

**Unit (mocked, pure):** `buildDigestBlocks(ideas)` — given a list of 1-3 ideas, produces
the correct Block Kit structure:
- Header section present.
- One `section` + one `actions` block per idea.
- Dividers between ideas but not after the last.
- Each button has `action_id: "draft_this"` and `value` matching the idea's `id`.
- Handles 1 idea (no dividers), 2 ideas (1 divider), 3 ideas (2 dividers).

**Integration (live deploy):** Hit `POST /api/digest/generate` with Trent's
`slackUserId`. Confirm:
- A DM arrives in the bot conversation with the correct format.
- Each "Draft this" button is clickable (it will error since the interactivity endpoint
  doesn't exist yet — that's expected and fine).
- `sca_digests` has a row with the correct `rep_id`, `idea_ids`, and `message_ts`.

## Empty pool behavior

If `selectTopCandidates` returns zero ideas, no DM is sent and no `sca_digests` row is
written. The route returns `{ ideaCount: 0, messageTs: null }` so the caller (or future
cron) knows the pool is dry and can decide whether to trigger a refill.

## Env vars

No new env vars. Consumes existing:
- `SCA_INTERNAL_KEY` — route auth.
- `SLACK_BOT_TOKEN` — Slack Web API (via `lib/slack/client.ts`).
- `SCA_SUPABASE_URL` / `SCA_SUPABASE_SERVICE_KEY` — digest record + idea reads.
