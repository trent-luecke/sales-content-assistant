# Handoff — Multi-Platform Drafting Brainstorm

**Created:** 2026-08-05
**For:** a fresh session that will brainstorm → spec → plan → build the multi-platform
(LinkedIn / Instagram) drafting feature for the Sales Content Assistant (SCA).
**How to use this:** read it top to bottom, then start with the `superpowers:brainstorming`
skill. This doc is a jump-start, not a spec — the design decisions are still open and are
the brainstorm's job. Do not skip brainstorming and jump to a plan.

---

## What the SCA is (one paragraph)

A Slack-first "habit-formation tool disguised as a content assistant" for TeamBuildr sales
reps. It mines a rep's own Avoma demos into a pool of anonymized content ideas, DMs a weekly
digest of ~3 ideas, and on a "Draft this" click writes a first-draft social post **in the
rep's voice** into a Slack Canvas the rep iterates on and copies out to post themselves. The
rep is always the author; the AI never publishes. **Hard rule: no customer/prospect/company/
deal names ever appear in generated content** — this is the highest-stakes constraint.
Full context: [original design](../specs/2026-07-29-sales-content-assistant-design.md) and
[Phase 1 design](../specs/2026-07-29-sales-content-assistant-phase-1-design.md).

## Where we are (Phase 1 build order, 8 steps)

1. Foundation (Supabase, tables, RAG read) — ✅ done
2. Profiles + mining lib — ✅ done
3. Onboarding web flow — ✅ done
4. Pool refill (`/api/pool/refill`) — ✅ done
5. Digest generate + deliver (`/api/digest/generate`) — ✅ done, live-verified
6. **"Draft this" interactivity + draft loop** — ✅ done, live-verified on production
7. Iteration loop (thread reply → edit Canvas in place) — **NOT built yet**
8. Weekly delivery cron — **NOT built yet** (deliberately last)

**The multi-platform feature is NEW scope**, not one of the 8 steps. It layers onto step 6's
draft generation and will interact with step 7 (see "Constraints" below). It's worth its own
spec → plan → build cycle.

**Deployment:** live on a stable production URL, `https://sales-content-assistant.vercel.app`
(the Slack Interactivity Request URL points at `/api/slack/interactivity` there; env vars are
set for BOTH Production and Preview, so deploys no longer churn the Slack URL). Secrets never
live in local files — all secret-using code is verified on a Vercel deploy, not locally.

## The feature to design

TeamBuildr reps post to **LinkedIn and/or Instagram**. Today the draft loop produces ONE draft
with no platform awareness — it reads well on LinkedIn but isn't tailored for Instagram (which
is image-heavy and wants more concise copy + a visual). We want the assistant to handle
multi-platform reps.

Trent raised two approaches (both still on the table — the brainstorm should pick/blend):
- **A. Generate both versions at once** — a LinkedIn draft and an Instagram draft. The IG one
  should be more concise AND include ideas for a visual asset (either concepts a rep takes to
  an image generator, or — bigger — grabbing an existing marketing asset).
- **B. Ask which platform after the click** — insert a step between "Draft this" and canvas
  generation with three options: Instagram only, LinkedIn only, or both.

## Controller's recommendation (starting point, not a decision)

This was discussed with Trent on 2026-08-05; use it as the opening proposal and pressure-test it:

- **Leverage `profile.channels`, which already exists.** Onboarding captures each rep's
  channels (`["LinkedIn", "Instagram"]`, subset) — see `lib/onboarding.ts` (`CHANNELS`) and
  `Profile.channels` in `lib/profiles.ts`. So we are NOT starting blind and don't have to ask
  blindly or generate for platforms a rep never uses.
- **Default to the rep's configured channel(s); only surface a choice when they have BOTH.**
  Single-channel rep → draft for that platform, no question, no friction.
- **Lean toward one-draft-per-platform (a session per platform) over two drafts in one Canvas.**
  Reason: the step-7 iteration loop is being built as one-Canvas = one-draft = one-thread. Two
  drafts in a single Canvas makes "make it punchier" ambiguous (which one?) and forces step 7
  to disambiguate every turn. Prefer Trent's **B** (per-post platform choice) when both, so
  each draft session stays a clean 1:1.
- **Scope the Instagram "visual" carefully — it's two very different lifts:**
  - *Visual CONCEPT suggestions (text the rep takes to an image generator)* = lightweight, just
    extra text in the draft. **Do this in v1.**
  - *Grab an existing marketing asset* = a real integration (a digital-asset library / Drive
    search / DAM we haven't wired). **Defer to a later phase** — don't let it balloon v1.

## Open design questions the brainstorm must resolve

1. When a rep has BOTH channels: ask per-post (a second set of Block Kit buttons / a select after
   the "Draft this" click) vs. generate both automatically? (Controller leans: ask.)
2. If "both" is chosen: two separate Canvases + two threads (two draft sessions), or one Canvas
   with two sections? (Controller leans: separate, to keep step-7 iteration unambiguous — but
   this needs to reconcile with how step 7 will actually be built.)
3. Where does platform selection live in the flow — a new interstitial (`draft_this` →
   platform buttons → generate), or read silently from `profile.channels`?
4. How exactly does the Instagram draft differ (length target, format, hook style, the visual-
   concept suggestion block)? Does it belong in the Canvas body or the thread message?
5. Does the digest "Draft this" button change, or does platform selection happen entirely
   after the click? (The button contract today: `action_id: "draft_this"`, `value: <idea uuid>`
   — exported as `DRAFT_THIS_ACTION` from `lib/digest.ts`.)
6. How does this reconcile with step 7 (iteration), which isn't built yet? Per-platform threads?
   It may be worth designing step 7 and multi-platform together, or sequencing deliberately.

## Key files / code facts the design must respect

- **`lib/generation.ts`** — `buildDraftPrompt(idea, profile, moment)` (pure) and
  `generateDraft(idea, profile, moment): Promise<{ body, wasRedacted }>`. Produces ONE draft,
  no platform param today. Multi-platform likely adds a `platform` argument and per-platform
  prompt shaping. The anonymization guardrail (forbiddenNames → containsAny → regenerate →
  redact) is inside `generateDraft` and applies to every generated draft regardless of platform.
- **`lib/draft.ts`** — `handleDraftThis(payload)` runs post-ack inside `waitUntil` and MUST
  NEVER throw. Current flow: claim idea (atomic) → post "drafting…" interim → read demo moment →
  generateDraft → createCanvasInDM → update interim to opener → write `sca_thread_map` row. One
  Canvas + one thread + one `sca_thread_map` row per idea today.
- **`lib/slack/canvas.ts`** — `createCanvasInDM(channel, title, markdown)`, `editCanvas(...)`.
- **`app/api/slack/interactivity/route.ts`** — verifies Slack signature → parses the
  form-encoded `payload` → acks 200 → dispatches `draft_this` to `handleDraftThis` via
  `waitUntil`. A platform-choice step would add a new `action_id` handled here.
- **`lib/digest.ts`** — `buildDigestBlocks` + `DRAFT_THIS_ACTION` (the `"draft_this"` string).
- **`lib/profiles.ts`** — `Profile.channels: unknown[]` (holds the rep's platforms).
- **Data model** — `sca_thread_map (rep_id, slack_channel, thread_ts, canvas_id, idea_id)`,
  unique on `(slack_channel, thread_ts)`. If "both" means two draft sessions, consider whether a
  `platform` column / multiple rows per idea is needed.
- **Model / stack:** TypeScript, Next.js 16 App Router on Vercel, `@slack/web-api`, AI SDK
  (`ai` `generateText` + `@ai-sdk/anthropic`, model `claude-sonnet-5`), Vitest. Pure logic is
  unit-tested; Slack/RAG/AI I/O is verified on one live Vercel deploy (the established pattern).
- **Monorepo hygiene:** repo root is `/Users/trentluecke/dev/Claude-Projects/sales-content-assistant`
  inside the `Claude-Projects` monorepo — **never `git add -A`**; stage only this subdir and
  confirm with `git diff --cached --name-only`. Work is committed directly to `main` (Trent's
  established pattern; confirmed).

## Process to follow

1. `superpowers:brainstorming` — resolve the open questions above one at a time, propose
   approaches, present the design in sections, get Trent's approval, write the spec to
   `docs/superpowers/specs/YYYY-MM-DD-multiplatform-drafting-design.md`.
2. `superpowers:writing-plans` — turn the approved spec into a task-by-task plan.
3. `superpowers:subagent-driven-development` — execute (fresh subagent per task, review after
   each, final whole-branch review). Trent prefers this flow; commit directly to `main`.
   Live-verify on the production URL (fire a digest via `/api/digest/generate`, click through).

## Related open follow-ups (not blockers, but adjacent)

- **Step 7 (iteration loop)** and **step 8 (weekly cron)** are still owed for Phase 1. Multi-
  platform interacts most with step 7 — decide sequencing early.
- **Background task chips already filed** (visible in Trent's session UI):
  - `readRepDemos` → reuse the token-equality `isRepSpeaker` helper (voice-profiling consistency;
    same substring-match bug class fixed in `readDemoMoment`).
  - "Discard draft" / canvas-cleanup affordance — reps accumulate bot-owned canvases they can't
    delete from the Slack UI; the bot can delete via `canvases.delete`.
- **Carry-forward from step 6** (see `.superpowers/sdd/progress.md`): post-Canvas-failure can
  orphan a Canvas on retry; generic title fragments can slightly over-redact (safe direction);
  a `rejected` idea is labeled `already_used`. All accepted/minor.

## Quick status of the code as of this handoff

Step 6 shipped on `main` and is live-verified: the anonymization surface was hardened over
several review rounds (merged-span redaction, token-equality speaker matching, first-name-token
decomposition), the draft loop never throws post-ack and releases its claim on failure, and a
mining bug (ideas stored a fabricated `meetingId` — the LLM echoed the demo date — which crashed
`readDemoMoment`) was fixed by mapping a model-returned `demoNumber` back to the real meeting
UUID. All tests green (66), tsc clean.
