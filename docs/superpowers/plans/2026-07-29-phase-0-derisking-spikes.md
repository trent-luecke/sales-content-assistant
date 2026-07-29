# Sales Content Assistant — Phase 0: De-risking Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove — on real infrastructure, with real data — the three assumptions the Phase 1 core loop rests on, before any of it is built: (1) the Slack async-ack pattern works on Vercel, (2) a bot can drive a Canvas inside a DM, (3) auto-derived voice from Avoma demos sounds like the rep and anonymizes cleanly.

**Architecture:** A minimal Next.js (App Router) app on Vercel exposes a Slack Events endpoint that acks in <3s and finishes work in `waitUntil`. Two throwaway-but-real experiments probe the Slack Canvas API in a DM and the Avoma→voice→story pipeline. Every spike writes a verdict to a shared findings doc that gates Phase 1.

**Tech Stack:** TypeScript, Next.js App Router, Vercel (Functions + preview deploys), `@slack/web-api`, `@vercel/functions` (`waitUntil`), Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), Vitest, the existing `avoma-transcripts` MCP server / Avoma REST API.

## Global Constraints

- Runtime: Node.js (Vercel default Node 24). Local Node is v24.13.0; npm 11.6.2.
- Language: TypeScript, Next.js App Router only. No Pages Router.
- Project root: `/Users/trentluecke/dev/Claude-Projects/Sales Content Assisnt`. This lives inside the `Claude-Projects` monorepo git repo — do NOT `git init`; commit into the existing repo.
- Model: `claude-sonnet-5` via `@ai-sdk/anthropic` using `ANTHROPIC_API_KEY`. (Production may later move to the Vercel AI Gateway; the spike uses the direct provider because the key already exists.)
- Principle (hard rule, enforced in every generation prompt): **no customer, prospect, or deal specifics** in any generated content — stories are anonymized patterns only.
- Principle: the bot never posts to LinkedIn/Instagram and never sends anything on the rep's behalf without explicit in-chat approval. Spikes post only into the owner's own Slack DM / a test channel.
- Secrets live in `.env.local` (git-ignored) locally and in Vercel Project Environment Variables for deploys. Never commit secrets.
- Findings doc: `docs/superpowers/spikes/phase-0-findings.md`. Every spike appends a dated verdict section.

---

### Task 0: Project scaffold, credentials, and a proven deploy pipe

Stands up the Next.js app, wires the human-only credentials, and proves a bare route deploys to a public Vercel URL. Everything else builds on this.

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/page.tsx` (via scaffold)
- Create: `app/api/health/route.ts`
- Create: `.env.local` (git-ignored), `.gitignore` (if scaffold didn't add one)
- Create: `docs/superpowers/spikes/phase-0-findings.md`
- Create: `vitest.config.ts`
- Test: `lib/__tests__/health.test.ts`

**Interfaces:**
- Produces: a deployed Vercel **preview URL** (record it in the findings doc — Task 1 configures Slack against it).
- Produces: env var names every later task consumes: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `AVOMA_API_KEY`.

- [ ] **Step 1: Human prerequisites (the owner does these — cannot be automated)**

These require a person clicking through OAuth/console UIs; an agent cannot do them. Complete all before continuing:

1. **Slack app:** at api.slack.com/apps → "Create New App" → From scratch, in the TeamBuildr workspace.
   - OAuth & Permissions → Bot Token Scopes: `chat:write`, `im:history`, `im:write`, `channels:read`, `groups:read`, `canvases:write`, `canvases:read`, `files:write`. Install to workspace. Copy the **Bot User OAuth Token** (`xoxb-…`).
   - Basic Information → copy the **Signing Secret**.
   - Leave Event Subscriptions OFF for now (Task 1 turns it on once the URL exists).
2. **Anthropic key:** reuse the existing `ANTHROPIC_API_KEY` already used by `Melissa-Lead-Tracking/collectors/avoma.py`.
3. **Avoma key:** the `AVOMA_API_KEY` used by the same collector (for Task 3's fallback path).
4. **Vercel:** ensure you can log in with `vercel login`.

- [ ] **Step 2: Scaffold Next.js in the current (non-empty) directory**

Run:
```bash
cd "/Users/trentluecke/dev/Claude-Projects/Sales Content Assisnt"
npx --yes create-next-app@latest . --ts --app --eslint --no-tailwind --no-src-dir --import-alias "@/*" --use-npm
```
Expected: scaffolds into the existing folder (it keeps `docs/`). If it refuses due to the non-empty dir, scaffold into a temp dir and move files in, preserving `docs/`.

- [ ] **Step 3: Install spike dependencies**

Run:
```bash
npm install @slack/web-api @vercel/functions ai @ai-sdk/anthropic
npm install -D vitest
```
Expected: all install without peer-dependency errors.

- [ ] **Step 4: Add Vitest config and npm test script**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["**/__tests__/**/*.test.ts"] },
});
```
Add to `package.json` `"scripts"`: `"test": "vitest run"`.

- [ ] **Step 5: Write the failing health-route test**

Create `lib/__tests__/health.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { healthPayload } from "@/lib/health";

describe("healthPayload", () => {
  it("reports ok with a service name", () => {
    expect(healthPayload()).toEqual({ ok: true, service: "sca-phase0" });
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/health`.

- [ ] **Step 7: Implement the health module and route**

Create `lib/health.ts`:
```ts
export function healthPayload() {
  return { ok: true, service: "sca-phase0" } as const;
}
```
Create `app/api/health/route.ts`:
```ts
import { healthPayload } from "@/lib/health";

export async function GET() {
  return Response.json(healthPayload());
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Confirm `.env.local` is git-ignored and create it**

Create `.env.local` (leave real values for the owner to paste):
```
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
ANTHROPIC_API_KEY=
AVOMA_API_KEY=
```
Verify `git status` does NOT list `.env.local`. If it does, add `.env.local` to `.gitignore`.

- [ ] **Step 10: Deploy a preview and prove the pipe**

Run:
```bash
vercel link --yes
vercel deploy
```
Then, using the printed preview URL:
```bash
curl -s https://<preview-url>/api/health
```
Expected: `{"ok":true,"service":"sca-phase0"}`. Record the preview URL in the findings doc.

- [ ] **Step 11: Create the findings doc and commit**

Create `docs/superpowers/spikes/phase-0-findings.md`:
```markdown
# Phase 0 — De-risking Findings

## Environment
- Vercel preview URL: <fill in>
- Deployed: 2026-07-29

## Spike A — Slack async-ack on Vercel
_verdict pending_

## Spike B — Canvas in a DM
_verdict pending_

## Spike C — Avoma → voice → story
_verdict pending_
```
Commit:
```bash
git add -A
git commit -m "chore(sca): scaffold Next.js app + health route + deploy pipe (Phase 0 setup)"
```

---

### Task 1 (Spike A): Slack async-ack on Vercel

Proves the single scariest infra assumption: a Vercel function can satisfy Slack's 3-second ack while doing slow LLM work in the background and delivering the result into the thread. Protects the entire conversational-bot design.

**Files:**
- Create: `lib/slack/verify.ts`
- Create: `lib/slack/client.ts`
- Create: `lib/slack/handle-event.ts`
- Create: `app/api/slack/events/route.ts`
- Test: `lib/slack/__tests__/verify.test.ts`

**Interfaces:**
- Consumes: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`; the preview URL from Task 0.
- Produces: `verifySlackSignature(params)` → `boolean`; `postThreadReply({ channel, threadTs, text })` → `Promise<void>`; `handleEvent(payload)` → `Promise<void>`. Phase 1 reuses all three.

- [ ] **Step 1: Write failing tests for signature verification**

Create `lib/slack/__tests__/verify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySlackSignature } from "@/lib/slack/verify";

const secret = "test_signing_secret";
function sign(body: string, ts: string) {
  const h = crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return `v0=${h}`;
}

describe("verifySlackSignature", () => {
  const now = 1_700_000_000;
  const body = '{"type":"event_callback"}';
  const ts = String(now);

  it("accepts a valid signature within the time window", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: sign(body, ts), timestamp: ts, rawBody: body, now,
    })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: sign(body, ts), timestamp: ts, rawBody: body + "x", now,
    })).toBe(false);
  });

  it("rejects a stale timestamp (replay)", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: sign(body, ts), timestamp: ts, rawBody: body, now: now + 600,
    })).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: null, timestamp: null, rawBody: body, now,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test`
Expected: FAIL — `@/lib/slack/verify` not found.

- [ ] **Step 3: Implement signature verification**

Create `lib/slack/verify.ts`:
```ts
import crypto from "node:crypto";

export function verifySlackSignature(params: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: number;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = params;
  if (!signature || !timestamp) return false;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false; // replay window
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = Buffer.from(`v0=${hmac}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test`
Expected: PASS (all four cases).

- [ ] **Step 5: Implement the Slack client helper**

Create `lib/slack/client.ts`:
```ts
import { WebClient } from "@slack/web-api";

export const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function postThreadReply(args: {
  channel: string;
  threadTs?: string;
  text: string;
}): Promise<void> {
  await slack.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text,
  });
}
```

- [ ] **Step 6: Implement the event handler (dedup + LLM + reply)**

Create `lib/slack/handle-event.ts`:
```ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { postThreadReply } from "@/lib/slack/client";

// Slack retries deliver the same event_id up to 3x; dedup within the warm instance.
const seen = new Set<string>();

export async function handleEvent(payload: any): Promise<void> {
  const eventId: string | undefined = payload.event_id;
  if (eventId) {
    if (seen.has(eventId)) return;
    seen.add(eventId);
  }
  const event = payload.event;
  if (!event) return;
  // Ignore the bot's own messages and non-message events to avoid loops.
  if (event.type !== "message" && event.type !== "app_mention") return;
  if (event.bot_id || event.subtype) return;

  const userText: string = event.text ?? "";
  const { text } = await generateText({
    model: anthropic("claude-sonnet-5"),
    prompt: `You are a spike test. Reply in one short sentence confirming you received: "${userText}".`,
  });

  await postThreadReply({
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text,
  });
}
```

- [ ] **Step 7: Implement the Events route (ack fast, work in waitUntil)**

Create `app/api/slack/events/route.ts`:
```ts
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "@/lib/slack/verify";
import { handleEvent } from "@/lib/slack/handle-event";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payload = JSON.parse(rawBody);
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  waitUntil(handleEvent(payload)); // ack now, finish slow work after responding
  return new Response(null, { status: 200 });
}
```

- [ ] **Step 8: Deploy and set env vars on Vercel**

Run:
```bash
vercel env add SLACK_SIGNING_SECRET preview
vercel env add SLACK_BOT_TOKEN preview
vercel env add ANTHROPIC_API_KEY preview
vercel deploy
```
Expected: deploy succeeds; note the new preview URL.

- [ ] **Step 9: Turn on Slack Event Subscriptions and verify the handshake**

In the Slack app config → Event Subscriptions → enable → Request URL: `https://<preview-url>/api/slack/events`. Subscribe to bot events: `message.im`, `app_mention`. Save.
Expected: Slack shows **"Verified"** (this exercises the `url_verification` challenge path). Reinstall the app if prompted for new scopes.

- [ ] **Step 10: Manual end-to-end verification (the actual spike)**

DM the bot (or `@mention` it in a test channel) with "hello spike". Time the response.
Success criteria — record each in the findings doc:
- Slack shows no "operation_timeout" warning (ack was <3s). ✅/❌
- A reply from the bot lands in the same thread within ~10s. ✅/❌
- Sending 3 messages quickly does not produce duplicated replies (dedup works). ✅/❌
Check `vercel logs <preview-url>` to confirm the function acked before the LLM call completed.

- [ ] **Step 11: Write the verdict and commit**

Append to `docs/superpowers/spikes/phase-0-findings.md` under "Spike A": GO/NO-GO, measured ack + reply latency, and any gotchas (cold-start latency, retry behavior, `waitUntil` cutoff). If NO-GO, note the fallback to evaluate (e.g., a dedicated always-on host).
Commit:
```bash
git add -A
git commit -m "feat(sca): Slack async-ack spike on Vercel (Phase 0 Spike A)"
```

---

### Task 2 (Spike B): Canvas inside a DM

Proves — or disproves — that a bot can create and update a Canvas attached to a DM, which the core loop uses as the living-draft surface. This is an **API-behavior investigation**: the exact working method calls are the unknown, so the deliverable is a documented verdict plus a thin wrapper around whatever actually works.

**Files:**
- Create: `scripts/spike-canvas.ts`
- Create (only if a working path is found): `lib/slack/canvas.ts`

**Interfaces:**
- Consumes: `SLACK_BOT_TOKEN`, `@slack/web-api` client from `lib/slack/client.ts`.
- Produces (if GO): `createDraftCanvas({ channel, title, markdown })` → `Promise<{ canvasId: string }>` and `updateDraftCanvas({ canvasId, markdown })` → `Promise<void>`, for Phase 1 to reuse.

- [ ] **Step 1: Write the probe script**

Create `scripts/spike-canvas.ts`. It walks the candidate API calls in order and logs what each returns, so the run itself documents which path works:
```ts
import { WebClient } from "@slack/web-api";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const OWNER_USER_ID = process.env.SPIKE_OWNER_USER_ID!; // the owner's Slack user id (U…)

async function main() {
  // 1) Open a DM with the owner.
  const dm = await slack.conversations.open({ users: OWNER_USER_ID });
  const channel = (dm as any).channel.id as string;
  console.log("DM channel:", channel);

  // 2) Attempt a standalone canvas (canvases.create).
  try {
    const c: any = await slack.apiCall("canvases.create", {
      title: "Spike Draft",
      document_content: JSON.stringify({
        type: "markdown",
        markdown: "# Draft v1\n\nFirst line.\n\nSecond line.",
      }),
    });
    console.log("canvases.create OK:", JSON.stringify(c));
  } catch (e) {
    console.log("canvases.create FAILED:", (e as Error).message);
  }

  // 3) Attempt a conversation-attached canvas (conversations.canvases.create).
  try {
    const c: any = await slack.apiCall("conversations.canvases.create", {
      channel_id: channel,
      document_content: JSON.stringify({
        type: "markdown",
        markdown: "# Draft v1\n\nFirst line.\n\nSecond line.",
      }),
    });
    console.log("conversations.canvases.create OK:", JSON.stringify(c));
  } catch (e) {
    console.log("conversations.canvases.create FAILED:", (e as Error).message);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```
> Note: method names above are the candidates to try. Record which succeed; the Slack Canvas API surface is exactly what this spike verifies.

- [ ] **Step 2: Get the owner's Slack user id and run the probe**

Get the owner user id (Slack profile → "Copy member ID", `U…`). Run:
```bash
SPIKE_OWNER_USER_ID=U######## npx tsx scripts/spike-canvas.ts
```
(Install the runner if needed: `npm install -D tsx`.)
Expected: console prints which create call returned a `canvas_id` (or `ok:true` with a canvas reference), and which failed and why.

- [ ] **Step 3: Probe the update/patch path**

Extend `scripts/spike-canvas.ts`: after a successful create, capture the returned canvas id and attempt an edit that changes ONE section, to learn whether partial patching works or a full rewrite is required:
```ts
  const canvasId = "<paste from step 2 output>";
  try {
    const u: any = await slack.apiCall("canvases.edit", {
      canvas_id: canvasId,
      changes: JSON.stringify([{
        operation: "replace",
        document_content: { type: "markdown", markdown: "# Draft v2\n\nFirst line EDITED.\n\nSecond line." },
      }]),
    });
    console.log("canvases.edit OK:", JSON.stringify(u));
  } catch (e) {
    console.log("canvases.edit FAILED:", (e as Error).message);
  }
```
Re-run the script. In Slack, open the DM and confirm visually whether the canvas is visible in the DM and whether it updated in place.

- [ ] **Step 4: Record the verdict**

Append to the findings doc under "Spike B" — answer each concretely:
- Can the bot create a canvas the owner sees **in a DM**? (which method) ✅/❌
- Update in place: partial-section patch, full rewrite only, or not at all? 
- Formatting fidelity: do headings / bold / lists / links survive?
- Rate limits or size caps hit?
- **Verdict:** Canvas is the draft surface (GO) OR fall back to reposted "v2/v3" threaded messages (NO-GO). If NO-GO, note that Phase 1 uses the message-repost fallback.

- [ ] **Step 5: Promote the working calls into a wrapper (only if GO) and commit**

If GO, create `lib/slack/canvas.ts` wrapping exactly the calls that worked into `createDraftCanvas` and `updateDraftCanvas` (signatures in Interfaces above). If NO-GO, skip the file and note the fallback.
Commit:
```bash
git add -A
git commit -m "spike(sca): Canvas-in-DM investigation + verdict (Phase 0 Spike B)"
```

---

### Task 3 (Spike C): Avoma → voice → story on real demos

Proves the value engine on real data: can we pull the owner's demos, derive a voice profile that actually sounds like them, and mine one postable story that anonymizes cleanly? This is the failure mode most likely to quietly sink the product (bland voice), so it is validated by the owner's own judgment.

**Files:**
- Create: `scripts/spike-avoma-voice.ts`
- Create (outputs): `docs/superpowers/spikes/voice-profile-owner.md`, `docs/superpowers/spikes/story-candidate.md`

**Interfaces:**
- Consumes: the `avoma-transcripts` MCP server on `:8001` (`list_meetings`, `search_transcripts`) if running; else the Avoma REST API with `AVOMA_API_KEY` (pattern in `Melissa-Lead-Tracking/collectors/avoma.py`). Plus `ANTHROPIC_API_KEY`.
- Produces: two markdown artifacts the owner reviews; the extraction prompt shapes that Phase 1's `profiles/` and `sources/` reuse.

- [ ] **Step 1: Ensure a transcript source is available**

Start the Avoma MCP server (it was not reachable during planning):
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/mcp
```
Expected: non-`000`. If it stays down, use the REST fallback: reuse the auth + fetch approach in `Melissa-Lead-Tracking/collectors/avoma.py` (base `https://api.avoma.com`, `AVOMA_API_KEY`) to pull the owner's recent demo transcripts. Record which source was used.

- [ ] **Step 2: Pull 3–5 of the owner's recent demo transcripts**

Write `scripts/spike-avoma-voice.ts` to fetch the owner's demos (filter to demo/discovery calls where the owner is the rep) and print how many transcripts and total characters were retrieved. Cap each transcript at ~30k chars (matches the `_TRANSCRIPT_CHAR_LIMIT` in `avoma.py`).
Run:
```bash
npx tsx scripts/spike-avoma-voice.ts --list
```
Expected: prints 3–5 transcripts with dates and lengths. If zero, the rep→Avoma identity mapping is wrong — fix the filter before continuing.

- [ ] **Step 3: Derive a voice profile from the transcripts**

Extend the script to send the transcripts to `claude-sonnet-5` (AI SDK) with a prompt adapted from `OS-growth-machine/.claude/skills/ops-voice-extraction.md`: extract how the owner actually talks — recurring phrasing, sentence rhythm, level of formality, metaphors, what they get animated about — as 5–8 named voice traits with verbatim example lines. Write the result to `docs/superpowers/spikes/voice-profile-owner.md`.
Run:
```bash
npx tsx scripts/spike-avoma-voice.ts --voice
```
Expected: `voice-profile-owner.md` is written with named traits + real quotes.

- [ ] **Step 4: Mine one anonymized story candidate**

Extend the script: from the same transcripts, extract ONE story worth posting, drafted in the derived voice, with the hard anonymization rule in the prompt — "Never name the customer, prospect, company, or any deal specifics. Render it as an anonymized pattern (e.g. 'a strength coach I spoke with last week…'). If you cannot anonymize it, say so and pick another." Write to `docs/superpowers/spikes/story-candidate.md`.
Run:
```bash
npx tsx scripts/spike-avoma-voice.ts --story
```
Expected: `story-candidate.md` contains a short post draft + a one-line note on which real moment it came from.

- [ ] **Step 5: Owner judgment (the actual success gate)**

The owner reads both artifacts and answers in the findings doc:
- Does the voice profile sound like you, or generic? (1–5)
- Is the story candidate something you'd actually post? (yes/no)
- Did anything leak a customer/prospect/deal specific? (yes = the guardrail failed and must be hardened before Phase 1)

- [ ] **Step 6: Record the verdict and commit**

Append to the findings doc under "Spike C": GO/NO-GO with the owner's scores. GO if voice ≥4/5, story is postable, and zero leakage. If bland (≤3), record what was missing (more transcripts? better prompt? more self-report signal?) so Phase 1's onboarding is designed to fix it.
Commit:
```bash
git add -A
git commit -m "spike(sca): Avoma voice + story extraction on real demos (Phase 0 Spike C)"
```

---

## Phase 0 Exit Criteria

Phase 1 planning begins only after the findings doc records a verdict for all three spikes:
- **Spike A GO:** async-ack works on Vercel with acceptable latency → conversational bot is viable as designed.
- **Spike B verdict:** Canvas-as-draft (GO) or message-repost fallback (NO-GO) — either way Phase 1 knows its draft surface.
- **Spike C GO:** voice is convincing and stories anonymize → the value engine is real.

Any NO-GO does not stall the project; it changes the Phase 1 plan (different draft surface, or an onboarding tweak to strengthen voice). The point of Phase 0 is to learn that now, cheaply.
