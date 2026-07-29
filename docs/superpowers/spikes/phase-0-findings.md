# Phase 0 — De-risking Findings

## Environment
- Vercel scope: tluecke616-3993's projects
- Vercel project: sales-content-assistant
- Deployment URL (first deploy → production): https://sales-content-assistant-kxyb7gteq-tluecke616-3993s-projects.vercel.app
- Deployed: 2026-07-29
- NOTE: Deployment Protection (Vercel Authentication) must be OFF for the Slack webhook to be reachable. Security boundary is Slack signature verification (Task 1), not Vercel Auth.

## Phase 1 — Plan 1 (Foundation + Mining): COMPLETE ✅ (2026-07-29)
Libs shipped (`supabase`, `guardrail`, `ideas`, `profiles`, `mining`), 16 unit tests green,
tsc clean. Live verification (temp route, since removed) for Trent as guinea pig:
6 demos → 7 voice traits (captured real tics, e.g. "'Beautiful' as verbal punctuation") →
16 ideas mined + inserted → top-3 anonymized hooks, **no customer names leaked** (source had
"John Kurta"/"Josh"/"Fusion High Performance Training"; none surfaced).

**Carry-forward for the draft-loop plan:** strengthen the anonymization guardrail where the
actual *post* is generated — also forbid the meeting's `prospect_name` and add a second-pass
`containsAny` check on the final draft. The digest-hook path relied mostly on prompt-level
anonymization (title-name extraction is weak for colon-style titles); it held, but the real
leakage surface is the drafted post, not the hooks.

---

## Phase 0 result: ALL THREE GO ✅
Async-ack (A), Canvas-in-DM (B), and voice/story extraction (C) all validated on real
infrastructure/data. The architecture in the design spec holds with no fallbacks needed.
Carry-forward blocker for Phase 1 — **RESOLVED 2026-07-29** (see note below): the Avoma RAG
`list_meetings` failure was NOT Supabase; it was the client building ilike patterns with raw
`%` wildcards, which 1101'd at Cloudflare's edge. Fixed in `Avoma-Ingest-Chris`
(branch `fix/list-meetings-ilike-wildcard-encoding`, commit f960eb8). Verified live: per-rep
enumeration works (Chris=50 demos, Trent=17). Pending: merge + restart the MCP server so the
running instance loads the fix.

---

## Spike A — Slack async-ack on Vercel
**Verdict: GO** ✅ (verified live 2026-07-29)

- Preview URL under test: https://sales-content-assistant-kti0qsr90-tluecke616-3993s-projects.vercel.app
- Slack events endpoint: `/api/slack/events`
- Health on preview: 200 ✅ (publicly reachable)
- Unsigned POST rejected: 401 ✅ (signature verification live on deployed fn)
- URL verification: Slack showed "Verified" ✅ (challenge acked within 3s)
- Ack latency (<3s?): YES — Slack Verified + no retry storms observed
- Reply latency: bot replied in-thread within seconds ("Received: 'hello spike'")
- Dedup on retries: single reply, no duplicates (in-instance `seen` set + retry-safe by
  design; not yet stress-tested with rapid-fire messages)
- Logs: clean `info`-level POST completions, zero errors
- Gotchas: preview URL changes on every redeploy — update Slack Request URL if redeployed.
  For Phase 1, alias to a stable domain (or use production env) so the Slack URL is fixed.

**Conclusion:** The conversational-bot architecture (Vercel + Events API + `waitUntil`
async-ack) is viable exactly as designed. No fallback needed.

## Spike B — Canvas in a DM
**Verdict: GO** ✅ (verified live 2026-07-29)

- Create in DM (which method): **`conversations.canvases.create`** (canvas attached to the
  DM conversation) — renders natively in the chat, owner sees it immediately.
- REJECTED path: `canvases.create` (standalone) + posting a `slack.com/canvas/<id>` link —
  the link does not open for the user. Do NOT use in Phase 1.
- Update in place: **`canvases.edit`** with a `replace` operation works — the in-DM canvas
  updated from v1 → v2 visibly, same canvas, no new one spawned. (Full-doc replace verified;
  section-level patching not separately tested — replace is sufficient for the draft loop.)
- Formatting fidelity: H1 heading, **bold**, bullet list, and clickable link all render
  correctly (owner confirmed).
- Access: `canvases.access.set` grants the owner write access (used for standalone path;
  not needed for the conversation-attached path).
- Rate/size limits: none hit at spike scale.
- Secrets note: local scripts can't read real secrets (env redaction writes `[SENSITIVE]`
  to files), so Canvas was probed via a temporary Vercel route using the real env, then the
  route was removed. Phase 1 Canvas code runs server-side on Vercel anyway.

**Conclusion:** Canvas is the Phase 1 living-draft surface. Use
`conversations.canvases.create` to create the draft in the rep's DM and `canvases.edit`
(replace) to update it as they iterate. No message-repost fallback needed.

## Spike C — Avoma → voice → story
_artifacts drafted; awaiting owner scoring_

- Guinea pig: **Chris Reynolds** (owner Trent is not a demo rep / barely in the corpus;
  Chris is a real rep + Trent's own brain-dump example, so Trent can judge authenticity).
- Transcript source used: **`search_transcripts` MCP tool** (works). Gathered Chris's
  turns across ~7 demos by filtering search results to his labeled turns.
- **`list_meetings` was DOWN — now FIXED (2026-07-29).** Root cause (isolated via systematic
  debugging): the `rep`/`prospect` filters built ilike patterns with raw `%` wildcards
  (`rep_name=ilike.%Trent%`). Raw `%` in a URL query string is invalid percent-encoding, so
  Supabase's Cloudflare edge threw a 1101 *before* Postgres — which is why unfiltered queries
  and the `search_chunks` RPC (POST body, no URL pattern) worked but any name filter 500'd.
  Fix: use PostgREST's native `*` wildcard (`Avoma-Ingest-Chris` commit f960eb8, +regression
  test). Verified live against Supabase. **Remaining:** merge the branch and restart the
  running MCP server instance (it has the old code in memory).
- Extraction done natively by Claude in-session (env redaction blocks a local script
  from reading ANTHROPIC_API_KEY; production runs this server-side on Vercel).
- Artifacts: `voice-profile-chris.md`, `story-candidate-chris.md`.
- Voice sounds like Chris (1–5): **4/5** (Trent)
- Story is postable (yes/no): **Yes** (Trent)
- Any customer/deal leakage (yes/no): **No** (Trent)

**Verdict: GO** ✅ (Trent-scored 2026-07-29). Auto-derived voice is convincing (4/5) and
the mined story is postable with clean anonymization — on a *floor* sample (~7 demos via
search, not the full set). The value engine is real. Expect higher fidelity in Phase 1
once full per-rep demo enumeration is available.

**Carry-forward for Phase 1:** fix the `list_meetings` / `meetings`-table Supabase error
so per-rep demos can be enumerated cleanly (blocks the "whose demos" scoping, not the
extraction quality).
