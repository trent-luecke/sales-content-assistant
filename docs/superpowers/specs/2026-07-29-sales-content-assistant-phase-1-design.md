# Sales Content Assistant — Phase 1 Design Spec (Core Loop, Single Rep)

**Date:** 2026-07-29
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke
**Builds on:** [Phase 0 spikes — all GO](../spikes/phase-0-findings.md) and the
[original design spec](2026-07-29-sales-content-assistant-design.md).

## Goal

Deliver the working core loop for **one rep, private only**: magic-link web onboarding
(a pre-seeded profile they tighten) → a candidate-idea pool mined from their demos → an
on-demand digest of ~3 ideas in Slack → a "Draft this" button → a Canvas draft they
iterate on in-thread → they copy out and post manually.

The weekly delivery **cron is deferred to the very last step** ("loop first, cron last") —
everything else is proven before we automate scheduling.

## Scope

**In scope:** onboarding, voice/profile creation + storage, idea pool + refill, on-demand
digest generation + delivery, the Draft-this button, the Canvas draft + in-thread iteration
loop, the anonymization guardrail, per-rep isolation. Single rep (the guinea pig). Private
(rep ↔ bot DM) only.

**Out of scope for Phase 1** (deferred): the weekly delivery cron is built *last* and is the
only scheduled piece; the shared "steal-worthy seed" channel + re-voicing (Phase 2);
multi-rep rollout (Phase 2); event-driven nudges; "mark as posted" niceties; product-update
content vein.

## Inherited principles (from the original spec — still binding)

1. Rep is the author; the AI never publishes. No auto-posting.
2. Predictable, never ambushing (the digest waits; it does not demand).
3. **No customer/prospect/deal specifics in generated content** — anonymized patterns only.
4. Opt-in / private by default.

## Architecture

**One Next.js app on Vercel, two surfaces.** The same app scaffolded in Phase 0 hosts both
the web onboarding pages and the Slack bot API routes. No second project.

**Delivery surface:** the drafting loop lives in the **rep ↔ bot DM** — a Slack `im`
conversation (e.g. `D0BL…`), verified in Spike B. Canvases attach to that `im` via
`conversations.canvases.create`; the bot surfaces the DM proactively by posting the digest
(`conversations.open` → post), so reps never hunt for it.

### Components (each a focused unit)

- **Web onboarding** — `/onboard/[token]` page + `/api/onboard/skim` (derive draft profile
  from demos) + `/api/onboard/save`.
- **Slack** — `/api/slack/events` (exists, from Phase 0), `/api/slack/interactivity` (new —
  the "Draft this" button), plus internal triggers `/api/pool/refill` and
  `/api/digest/generate`.
- **`lib/`** — `supabase` (SCA client + a read-only RAG client), `profiles`, `ideas` (pool),
  `mining` (RAG demo read + Spike-C extraction), `generation` (voice-conditioned drafting +
  anonymization guardrail), `slack` (client, canvas, events, interactivity), `digest`
  (assemble + deliver).

### State: Supabase (separate SCA project) + lean on Slack

A **dedicated SCA Supabase project** (isolated from the live Avoma RAG for blast-radius and
least-privilege), plus a **read-only connection** into the RAG project for demo reads. The
mining flow never needs a cross-DB join — it is "given a rep, read their demos" (one query to
the RAG) → extract → write ideas to the SCA project.

For live drafting, lean on Slack: the **Canvas is the current draft**, the **thread is the
conversation**, and `sca_thread_map` is the only session state we keep.

### Data model (SCA Supabase project)

- **`sca_profiles`** — `id`, `avoma_rep_name`, `slack_user_id`, `magic_token`, `display_name`,
  `voice_traits` (jsonb), `background`, `angle`, `channels` (jsonb), `admired_post`,
  `status` (`draft`|`active`), `created_at`, `updated_at`.
- **`sca_ideas`** (the pool) — `id`, `rep_id` (fk profiles), `source` (`demo`|`organic`),
  `source_ref` (jsonb, internal — e.g. meeting id/moment), `hook` (text), `rationale` (text,
  why it'd land), `score` (float), `status` (`candidate`|`used`|`rejected`), `created_at`,
  `used_at`.
- **`sca_thread_map`** — `id`, `rep_id`, `slack_channel` (the `im`), `thread_ts`, `canvas_id`,
  `idea_id`, `created_at`. The "lean on Slack" glue: lets the stateless bot rebuild context
  on each reply (thread → canvas + idea + profile).
- **`sca_digests`** — `id`, `rep_id`, `delivered_at`, `idea_ids` (jsonb), `message_ts`.
  Light tracking of what was sent.

## Flows

### 1. Onboarding (web, magic link) — "reflect, don't ask"

1. Owner generates a per-rep magic link → `sca_profiles` row created (`status=draft`,
   `magic_token`, `avoma_rep_name` + `slack_user_id` pre-wired).
2. Rep opens `/onboard/[token]`. On load, `/api/onboard/skim` reads a handful of their demos
   from the RAG (read-only), runs the Spike-C extraction, and returns a **draft profile** —
   voice traits with real example lines + a guessed background/angle.
3. The form renders that draft **pre-filled**. The rep's job is to **tighten** it (fix a
   trait, edit a line) and add specifics (background, unique angle, preferred channels, one
   admired post). This turns setup into a ~5-minute editing task, not a self-report — humans
   are bad at self-reporting, and this makes the first impression "it already gets me."
4. `/api/onboard/save` writes the finalized profile and flips `status=active`. No login.

To bootstrap development, the guinea-pig profile can be seeded (as in the Spike-C Chris
profile) while the onboarding UI is built in parallel.

### 2. Pool refill + digest generation

- **Refill** (`/api/pool/refill`; triggered manually in loop-first, cron later): pulls the
  rep's not-yet-mined demos, extracts candidate story-moments, generates organic-angle ideas
  from the profile, scores them, inserts into `sca_ideas` as `candidate`, dedups against
  existing ideas.
- **Digest** (`/api/digest/generate`): selects the top ~3 `candidate` ideas (blended
  demo + organic), posts a DM listing each as **hook + why-it'd-land**, each with a
  **"Draft this" button**. Records `sca_digests`. The weekly cron (built last) calls this
  same endpoint on schedule — that is the entire "cron last" story.

### 3. Draft loop (Slack thread + Canvas)

1. Rep clicks **"Draft this"** → Slack POSTs `/api/slack/interactivity`. Bot acks fast, then
   (async, `waitUntil`): marks the idea `used`, calls `generation` to write a first draft **in
   the rep's voice with the anonymization guardrail enforced**, creates a Canvas in the DM
   (`conversations.canvases.create`), opens a thread ("First cut's in the canvas above — tell
   me what to change"), and writes the `sca_thread_map` row.
2. Rep iterates in-thread ("punchier," "cut the CTA"). Each reply → `/api/slack/events` → bot
   looks up `sca_thread_map` by `thread_ts` (+ channel) → loads idea + profile, reads the
   current Canvas, applies the edit via `generation`, updates the Canvas in place
   (`canvases.edit`, replace), replies with a short encouraging note.
3. Rep copies the final draft from the Canvas and posts to LinkedIn/IG themselves.

Design property: **the Canvas is the source of truth for the draft, the thread is the
conversation, and `sca_thread_map` is the only session state we keep** — everything else the
stateless bot reconstructs each turn.

## Isolation principle (multi-rep safety, baked in now)

Vercel Fluid Compute reuses a function instance across requests from *different reps*, so
cached rep identity would be a cross-rep data-leak hazard. Therefore:

- **No module-global mutable rep state.** Every handler resolves rep identity fresh from the
  incoming request (the event's `user` + `channel`) and threads it explicitly through
  `mining`/`generation`/etc.
- **Every read/write is keyed by rep.** `sca_thread_map` by `thread_ts` + `slack_channel` +
  `rep_id`; ideas/profiles by `rep_id`. A thread reply can only resolve to its own row.
- The event-dedup `Set` (from Phase 0 Spike A) is keyed by Slack's globally-unique `event_id`,
  so it cannot cross reps; it will be hardened but is not an identity risk.

Slack itself isolates the *visible* artifacts: each rep↔bot DM is a distinct private `im`
channel, and canvases attach to a specific `im` — one rep cannot see another's conversation
or canvas. Our job is only to not cross wires in our own state.

## Build order (each step independently testable; cron dead last)

1. **Foundation** — SCA Supabase project, the 4 tables, read-only RAG connection.
2. **Profiles + mining lib** — reuse Spike-C extraction against the RAG read connection.
3. **Onboarding web flow** — magic link → skim → editable pre-filled form → save.
4. **Pool refill** — mine → `sca_ideas` candidates, with dedup.
5. **Digest generate + deliver** — top-3 blended, DM with "Draft this" buttons.
6. **Interactivity endpoint** — button → voice-conditioned first draft → Canvas + thread +
   `sca_thread_map`.
7. **Iteration loop** — extend `/api/slack/events`: thread reply → `thread_map` lookup →
   Canvas edit in place.
8. **(Last) weekly delivery cron** — Vercel Cron calls `/api/digest/generate` on schedule.

## Testing

- **Unit** (mocked, per Phase 0 style): profile-derivation shaping; pool dedup + ranking;
  `thread_map` lookup; **anonymization-guardrail test** — feed generation a source moment
  containing a known customer name and assert the output never contains it.
- **Isolation test** — fire two reps' events through one warm handler instance; assert each
  only ever touches its own rows.
- **Integration** (deployed preview + live Slack/Supabase, the Phase-0 spike pattern):
  onboarding round-trip; the Draft-this button; the Canvas iteration loop.

## Risks

- **Anonymization leakage** (highest stakes) — defense in depth: guardrail in the generation
  prompt + a post-generation PII check against the idea's `source_ref` names + the rep reviews
  before posting (human in the loop).
- **Voice quality / drift** — mitigated by the onboarding edit step and mining the rep's own
  demos; the owner is the guinea pig, so bland output is caught before any teammate sees it.
- **Warm-instance rep mixing** — the isolation principle + test above.
- **Magic-link exposure** — tokens are unguessable; add expiry / one-time-use, since a link
  exposes only that rep's onboarding (low sensitivity).
- **RAG read dependency** — SCA depends on the RAG Supabase being up and `list_meetings`
  fixed (fixed this session; carry-forward note in the findings doc).
- **Cost** — trivial at one rep; the pool avoids re-mining every digest.

## Guinea pig

Default to **Trent** as the Phase 1 guinea pig (dogfood on self before exposing a teammate;
17 demos indexed). Chris Reynolds (50 demos, profile already drafted in Spike C) is the
natural first *real-rep* pilot in Phase 2. Adjustable.
