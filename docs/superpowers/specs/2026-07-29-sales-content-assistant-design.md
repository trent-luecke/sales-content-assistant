# Sales Content Assistant — Design Spec

**Date:** 2026-07-29
**Status:** Approved (design), pending implementation plan
**Owner:** Trent Luecke

## Problem

TeamBuildr salespeople want a stronger individual social presence on LinkedIn and
Instagram, but most don't post. On an internal sales call, the consensus blocker
was not tooling — it was that people don't know what to post, don't believe what
they'd post is worth posting, and feel like they're shouting into the void.

Generic AI content generators do not solve this. Reps aren't using them, because
generic AI copy feels fake, and "AI, write me a post" still leaves them staring at
a blank page. The thing that actually helps is the experience of brainstorming with
a credible assistant that (a) hands you a specific thing worth saying, sourced from
your own real work, and (b) reinforces that it's worth posting.

## What we're building

A **habit-formation tool disguised as a content assistant.** It removes the two
things that stop reps from posting — the blank page and the "is this worth it?"
doubt — by bringing each rep specific, personal raw material mined from their own
demos and background, drafting a starting point in their voice, and acting as the
credible third party in a conversational refinement loop. The rep is always the
author and publisher; the AI is the researcher and first-drafter.

### North star

**Team habit / culture shift.** Success = social posting becomes a normalized,
sustained, visible habit across the sales org — not a one-time push that fades in
a month. This reframes the metric away from "drafts generated" toward "sustained
posting behavior that spreads through the team."

## Non-negotiable principles

These constrain every downstream decision. Violating one to chase a metric kills
adoption for an AI-wary audience.

1. **Rep is the author; AI never publishes.** No auto-posting, ever. Human in the
   loop by design — the rep reviews everything before it is posted.
2. **Predictable, never ambushing.** Material *waits* for the rep in a predictable
   ritual; it does not ping them into a headspace they're not in. No real-time
   surprise nudges in v1.
3. **No customer/deal specifics in posts.** Demo-sourced stories are extracted as
   anonymized patterns ("a strength coach I talked to last week was drowning in
   spreadsheets until…"), never naming the customer, prospect, or deal specifics.
   Enforced as a hard rule in the generation layer.
4. **Opt-in everything for the wary.** Private by default; any team visibility is a
   deliberate choice the rep makes, never a default or a surveillance feature.

## Core loop (one rep's weekly experience)

1. **Monday, quietly:** a DM digest lands — "3 things from your week worth saying,"
   each a one-line hook + why it'd land, mined from the rep's demos + profile angle.
   It sits there. No pressure to act.
2. **When they have headspace:** the rep taps into one idea. The assistant opens a
   thread plus a **Slack Canvas** holding a first draft in *their* voice.
3. **Reinforcement loop:** they iterate conversationally in-thread ("punchier," "cut
   the CTA"). The Canvas updates in place as the single source of truth for the
   current draft — no scrollback archaeology. The assistant is encouraging and
   specific.
4. **Ship:** the rep copies the final draft from the Canvas and posts to LinkedIn/IG
   themselves. Optionally drops it in the shared channel as a steal-worthy seed.
5. **Cross-pollination:** another rep sees the seed, says "make this mine," and the
   assistant re-voices it through *their* profile.

## Delivery surface

**Slack-first.**

- **Thread** = the conversation (the chat back-and-forth reps already value).
- **Canvas** = the living draft, updated in place as iteration happens. Solves the
  one thing Slack is genuinely bad at for this use case: the evolving draft scrolling
  away in a thread.
- Identity is automatic: Slack user = the rep. No separate auth for v1.
- **Escape hatch (not built in v1):** if the team later wants richer editing
  (side-by-side versions, a real editor), a thin web app becomes an "open in editor"
  button. Design so it's addable; do not build until the habit exists (YAGNI).

**Canvas is a known risk** and gets a de-risking spike before anything is built on
it (see Phase 0). Fallback if Canvas can't do what we need: a well-formatted
threaded message reposted as "v2, v3."

## Content sources (v1)

Product updates are intentionally **cut from v1** — marketing already supplies reps
with assets to plug into posts, so automating that vein is low-value.

1. **Demo mining (backbone).** The rep's own demos from Avoma — real moments, real
   objections handled, real customer language. Most differentiated (nobody else can
   post these), most personal. Reuses the existing `avoma.py` extraction logic and
   the `ops-voice-extraction` methodology from `OS-growth-machine`.
2. **Organic / profile angles.** Ideas from the rep's background and unique angle
   (e.g., a rep not from the S&C world showing how approachable the product is to a
   layperson). Evergreen; depends on a well-built profile.
3. **Peer seeds (emergent, Phase 2).** Steal-worthy angles other reps share in the
   shared channel, re-voiced through the current rep's profile.

Demo mining and organic angles both rest entirely on a strong **per-rep profile**,
which makes the profile the engine, not a one-time setup step.

## Voice / profile engine

**Auto-derive from demos + light touch.** The rep's demos *are* their voice — it's
literally how they talk to prospects — so we auto-extract tone and phrasing from
their Avoma transcripts (reusing `ops-voice-extraction`), supplemented by a ~2-minute
self-report: background, unique angle, preferred channels, and one post they admire.
This keeps onboarding friction low (critical for an AI-wary team) while sourcing
voice from authentic material.

The profile also stores the rep → Avoma identity mapping so the system knows whose
demos to mine and, importantly, whose to ignore.

## Social layer

**Private loop + opt-in shared channel, framed as a content multiplier.**

- Drafting and iteration are 100% private (rep + bot DM).
- A shared channel exists not as a "high-five / I posted this" vanity feed, but as a
  place where a rep can drop a post or angle they think is **worth co-opting** by
  other reps for their own channels. One rep's good angle becomes seed material that
  others re-voice through their own profiles — cross-pollination that respects
  individual voice and further reduces the blank-page problem.
- **Manager visibility / leaderboard is deliberately excluded** unless the team
  explicitly asks for it. For this audience it reads as surveillance and is net
  negative to adoption.

## Architecture

Two distinct systems, both hosted on **Vercel** so there is nothing to keep alive on
a local machine (directly resolves the "does my machine need to be on / will I have
to babysit it" concern):

- **Weekly digest job** → **Vercel Cron**. One-directional; fires on schedule
  regardless of whether any local machine is on. Low risk.
- **Conversational bot** → **Vercel serverless function behind the Slack Events
  API**. A rep reply → Slack POSTs the endpoint → the function wakes, does its work,
  updates the Canvas, goes back to sleep. Scales to zero, effectively free at team
  volume, nothing to babysit.

**Events API over Socket Mode**, deliberately: Socket Mode requires a persistent
long-running process (machine-on, babysitting — the exact failure mode to avoid).
Events API fits serverless perfectly; Vercel provides the public HTTPS endpoint for
free. The one real cost is the **async-ack pattern**: Slack requires a response
within 3 seconds, but LLM drafting takes longer, so the function must ack
immediately and do the LLM work in the background (Fluid Compute + `waitUntil`),
then post the result as a follow-up. This is a solved pattern but is real code to
get right — de-risked in a spike.

### Stack

**TypeScript / Next.js App Router on Vercel.** Least-friction path for the Events API
endpoint, Vercel Cron, the async-ack pattern, and generation (AI SDK). The existing
Python `avoma.py` becomes the reference spec for extraction logic (small enough to
port), and/or the `avoma-transcripts` MCP server is queried directly for transcripts.
One clean stack rather than a Python/TS split.

### Components

- `profiles/` — one config per rep: voice traits (auto-derived from demos + light
  self-report), angle, preferred channels, Avoma identity mapping. The engine both
  source veins run on.
- `sources/` — demo miner (reuses `avoma.py` extractor + `ops-voice-extraction`),
  organic-angle generator (from profile), peer-seed intake (from shared channel).
- `digest/` — the scheduled job that assembles and delivers each rep's weekly digest.
- `bot/` — the Events API listener: thread conversation + Canvas read/update, with
  the async-ack pattern.
- `generation/` — voice-conditioned drafting with the anonymization guardrail baked
  in.

## Reused prior art

- `avoma-transcripts` MCP server (running on `:8001`): `list_meetings`,
  `search_transcripts`.
- `Melissa-Lead-Tracking/collectors/avoma.py`: Claude-based structured extraction
  from call transcripts (call type, gaps, objections, buying signals, competitors,
  action items).
- `OS-growth-machine/.claude/skills/ops-voice-extraction.md` and
  `ops-persona-extraction.md`: proven methodology for deriving voice/persona from
  real customer language.
- Slack MCP tooling (canvas create/read/update, messaging).

## Phasing

The owner (Trent) is the Phase 1 guinea pig before anyone else touches it.

### Phase 0 — De-risking spikes (before building on the scary parts)

1. **Canvas spike** — can a bot create/update a Canvas *in a DM*? Patch-a-section vs.
   full-rewrite? Formatting fidelity? Rate limits? Decides Canvas vs. reposted-message
   fallback.
2. **Async-ack spike** — Vercel function acks Slack in <3s, does LLM work in
   `waitUntil`, posts the result via follow-up. Prove the pattern end to end.
3. **Avoma + voice spike** — on the owner's own real demos: pull calls, derive a
   usable voice profile, mine one story that anonymizes cleanly. Validates the engine
   on real data and catches bland-voice failure early.

### Phase 1 — Core loop, single rep (owner)

Onboarding (light self-report + auto voice derivation) → profile store → weekly
digest (demo mining + organic angles) → thread conversation + Canvas draft →
anonymization guardrail → owner copies out and posts manually. Private only.

### Phase 2 — Small pilot + social layer

2–3 volunteer reps. Add the shared "steal-worthy seed" channel + "make this mine"
re-voicing. Multi-profile.

### Phase 3 — Earn-it later

Event-driven nudges (only after the team trusts the tool), product-update vein (low
priority), web-app editor escape hatch. Manager visibility excluded unless explicitly
requested.

## Risks

- **Adoption / AI-wariness** (the real, non-technical risk) — mitigated entirely by
  the four principles. Most of the sales team is wary of AI and will bristle at
  poorly-timed or surveillance-flavored behavior.
- **Voice quality** — if auto-derived voice comes out bland, the value prop
  collapses. Owner-as-guinea-pig in Phase 1 catches this before reputation is on the
  line.
- **Canvas limitations** — de-risked in Phase 0; reposted-message fallback exists.
- **Confidentiality** — hard anonymization guardrail in generation + rep reviews
  everything before posting.
- **Cost** — trivial at team volume (a handful of LLM calls per rep per week).
- **Avoma data access/permissions** — each rep's calls must be accessible and
  correctly mapped to that rep.

## Explicitly out of scope for v1

- Product-update content vein (marketing already covers it).
- Real-time / event-driven nudges.
- Web-app editor.
- Manager dashboard / leaderboard / any surveillance-flavored visibility.
- Auto-posting to LinkedIn/Instagram.
