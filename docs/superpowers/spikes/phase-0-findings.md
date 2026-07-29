# Phase 0 — De-risking Findings

## Environment
- Vercel scope: tluecke616-3993's projects
- Vercel project: sales-content-assistant
- Deployment URL (first deploy → production): https://sales-content-assistant-kxyb7gteq-tluecke616-3993s-projects.vercel.app
- Deployed: 2026-07-29
- NOTE: Deployment Protection (Vercel Authentication) must be OFF for the Slack webhook to be reachable. Security boundary is Slack signature verification (Task 1), not Vercel Auth.

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
_verdict pending_

- Transcript source used (MCP / REST): 
- Voice sounds like me (1–5): 
- Story is postable (yes/no): 
- Any customer/deal leakage (yes/no): 
- Verdict: 
