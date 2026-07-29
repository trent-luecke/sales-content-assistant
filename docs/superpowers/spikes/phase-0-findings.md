# Phase 0 — De-risking Findings

## Environment
- Vercel scope: tluecke616-3993's projects
- Vercel project: sales-content-assistant
- Deployment URL (first deploy → production): https://sales-content-assistant-kxyb7gteq-tluecke616-3993s-projects.vercel.app
- Deployed: 2026-07-29
- NOTE: Deployment Protection (Vercel Authentication) must be OFF for the Slack webhook to be reachable. Security boundary is Slack signature verification (Task 1), not Vercel Auth.

## Spike A — Slack async-ack on Vercel
_automated checks passed; awaiting live DM test_

- Preview URL under test: https://sales-content-assistant-kti0qsr90-tluecke616-3993s-projects.vercel.app
- Slack events endpoint: `/api/slack/events`
- Health on preview: 200 ✅ (publicly reachable)
- Unsigned POST rejected: 401 ✅ (signature verification live on deployed fn)
- Ack latency (<3s?): _pending live test_
- Reply latency: _pending live test_
- Dedup on retries: _pending live test_
- Gotchas: preview URL changes on every redeploy — update Slack Request URL if redeployed.
- Verdict: _pending_

## Spike B — Canvas in a DM
_verdict pending_

- Create in DM (which method): 
- Update in place (patch / full rewrite / none): 
- Formatting fidelity: 
- Rate/size limits: 
- Verdict (Canvas GO / message-repost fallback): 

## Spike C — Avoma → voice → story
_verdict pending_

- Transcript source used (MCP / REST): 
- Voice sounds like me (1–5): 
- Story is postable (yes/no): 
- Any customer/deal leakage (yes/no): 
- Verdict: 
