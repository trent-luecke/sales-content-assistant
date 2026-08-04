# Digest Generate + Deliver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the top ~3 candidate ideas as a single Slack DM with per-idea "Draft this" buttons, and record the delivery in `sca_digests`.

**Architecture:** A pure `buildDigestBlocks` shapes ideas into Block Kit blocks (unit-tested). `assembleAndDeliver` selects candidates, posts the DM via the existing Slack client, and records the digest (integration-tested live). A thin `POST /api/digest/generate` route authenticates, resolves the rep, and calls the lib — matching the `/api/pool/refill` pattern exactly.

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, `@slack/web-api`, `@supabase/supabase-js`, Vitest. Consumes existing libs (`lib/profiles`, `lib/ideas`, `lib/slack/client`).

## Global Constraints

- Project root: `/Users/trentluecke/dev/Claude-Projects/sales-content-assistant` (inside the `Claude-Projects` monorepo — never `git add -A`; stage only this subdir and confirm with `git diff --cached --name-only`).
- Runtime: Node.js (Vercel default). Language: TypeScript, App Router only.
- **Next.js 16:** route handlers are `export async function POST(req: Request)`. Mark DB/Slack-touching routes `export const dynamic = "force-dynamic"` so the build never prerenders them (secrets exist only on Vercel, not at build time).
- Route auth: `Authorization: Bearer $SCA_INTERNAL_KEY`, fail closed if the env var is unset (verbatim from `/api/pool/refill`).
- Isolation: no module-global mutable *rep* state. The route resolves the profile fresh from the request's `slackUserId`; the client never supplies a `rep_id`. (The Slack `WebClient` in `lib/slack/client.ts` is stateless w.r.t. reps and is fine module-scoped.)
- Secrets never land in local files (env redaction writes `[SENSITIVE]`) — all secret-using code is verified on a Vercel deploy, not a local script. Unit tests mock or avoid all I/O.
- Test file convention: `lib/__tests__/<name>.test.ts` (matches `vitest.config.ts`: `environment: "node"`, `include: ["**/__tests__/**/*.test.ts"]`, alias `@` → repo root).
- Button contract (binding on step 6): `action_id: "draft_this"`, `value: <idea uuid>`.

## Consumed existing interfaces (verbatim — do not re-implement)

From `lib/profiles.ts`:
- `interface Profile { id: string; avoma_rep_name: string; slack_user_id: string; magic_token: string; display_name: string | null; voice_traits: unknown[]; background: string | null; angle: string | null; channels: unknown[]; admired_post: string | null; status: "draft" | "active"; }`
- `getProfileBySlackUser(slackUserId: string): Promise<Profile | null>`

From `lib/ideas.ts`:
- `interface Idea { id?: string; rep_id: string; source: IdeaSource; source_ref: Record<string, unknown>; hook: string; rationale: string; score: number; status?: IdeaStatus; }`
- `selectTopCandidates(repId: string, n: number): Promise<Idea[]>`

From `lib/slack/client.ts`:
- `export const slack: WebClient` — the shared Slack Web API client (bot token from env).

From `lib/supabase.ts`:
- `scaClient(): SupabaseClient` — SCA read/write client.

---

### Task 1: `buildDigestBlocks` — pure Block Kit shaping

The only unit-testable surface: given 1-3 ideas, produce the exact Block Kit structure (header, one section + one actions block per idea, dividers only *between* ideas).

**Files:**
- Create: `lib/digest.ts`
- Test: `lib/__tests__/digest.test.ts`

**Interfaces:**
- Consumes: `Idea` (from `lib/ideas`), `KnownBlock` (type, from `@slack/web-api`).
- Produces: `DRAFT_THIS_ACTION = "draft_this"` (const), `buildDigestBlocks(ideas: Idea[]): KnownBlock[]`. Consumed by `assembleAndDeliver` (Task 2) and the test.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/digest.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildDigestBlocks, DRAFT_THIS_ACTION } from "@/lib/digest";
import type { Idea } from "@/lib/ideas";

const mk = (id: string, hook: string): Idea => ({
  id,
  rep_id: "rep-1",
  source: "demo",
  source_ref: {},
  hook,
  rationale: `why ${hook} lands`,
  score: 0,
  status: "candidate",
});

// Narrow helpers — Block Kit blocks are a big union; index by `type`.
const types = (blocks: { type: string }[]) => blocks.map((b) => b.type);
const buttons = (blocks: any[]) =>
  blocks.filter((b) => b.type === "actions").map((b) => b.elements[0]);

describe("buildDigestBlocks", () => {
  it("renders one idea: header + section + actions, no dividers", () => {
    const blocks = buildDigestBlocks([mk("id-1", "Go quiet in the demo")]);
    expect(types(blocks)).toEqual(["section", "section", "actions"]);
    // First section is the header; second carries the hook + rationale.
    const body = blocks[1] as any;
    expect(body.text.type).toBe("mrkdwn");
    expect(body.text.text).toContain("Go quiet in the demo");
    expect(body.text.text).toContain("why Go quiet in the demo lands");
  });

  it("puts a divider between ideas but never after the last", () => {
    const blocks = buildDigestBlocks([
      mk("id-1", "A"),
      mk("id-2", "B"),
      mk("id-3", "C"),
    ]);
    // header, (section,actions), divider, (section,actions), divider, (section,actions)
    expect(types(blocks)).toEqual([
      "section",
      "section", "actions",
      "divider",
      "section", "actions",
      "divider",
      "section", "actions",
    ]);
  });

  it("gives every button the draft_this action_id and the idea id as value", () => {
    const blocks = buildDigestBlocks([mk("id-1", "A"), mk("id-2", "B")]);
    const btns = buttons(blocks);
    expect(btns).toHaveLength(2);
    for (const b of btns) expect(b.action_id).toBe(DRAFT_THIS_ACTION);
    expect(btns.map((b) => b.value)).toEqual(["id-1", "id-2"]);
    expect(DRAFT_THIS_ACTION).toBe("draft_this");
  });

  it("returns only the header when there are no ideas", () => {
    // Defensive: assembleAndDeliver skips the empty case, but the shaper stays total.
    expect(types(buildDigestBlocks([]))).toEqual(["section"]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- digest`
Expected: FAIL — `@/lib/digest` not found.

- [ ] **Step 3: Implement the pure shaper**

Create `lib/digest.ts`:
```ts
import type { KnownBlock } from "@slack/web-api";
import type { Idea } from "@/lib/ideas";

// The button contract shared with the interactivity endpoint (Phase 1 step 6):
// every "Draft this" button carries this action_id and the idea's uuid as value.
export const DRAFT_THIS_ACTION = "draft_this";

// Pure: shape ideas into a single Block Kit message. Header, then per idea a
// section (bold hook + rationale) and an actions block with one "Draft this"
// button; dividers separate ideas but never trail the last one.
export function buildDigestBlocks(ideas: Idea[]): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Here are a few things worth saying this week.",
      },
    },
  ];

  ideas.forEach((idea, i) => {
    if (i > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${idea.hook}*\n${idea.rationale}` },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Draft this" },
          action_id: DRAFT_THIS_ACTION,
          value: idea.id ?? "",
        },
      ],
    });
  });

  return blocks;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- digest`
Expected: PASS (4 tests). Also run `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/digest.ts lib/__tests__/digest.test.ts
git diff --cached --name-only    # confirm all under sales-content-assistant/
git commit -m "feat(sca): buildDigestBlocks — pure Block Kit shaping + draft_this contract"
```

---

### Task 2: `assembleAndDeliver` — select, post DM, record digest

The I/O half of `lib/digest.ts`: select top candidates, post the Block Kit DM to the rep's bot conversation, record the `sca_digests` row. No unit test (needs real Slack + Supabase + secrets); verified live in Task 4, matching the Plan 1/2 approach.

**Files:**
- Modify: `lib/digest.ts` (append; keep Task 1's exports intact)

**Interfaces:**
- Consumes: `selectTopCandidates` (ideas), `slack` (slack/client), `scaClient` (supabase), `buildDigestBlocks` (Task 1), `Profile` (profiles).
- Produces: `assembleAndDeliver(profile: Profile): Promise<{ ideaCount: number; messageTs: string | null }>`. Consumed by the route (Task 3).

- [ ] **Step 1: Implement `assembleAndDeliver`**

Append to `lib/digest.ts` (add the three imports at the top, below the existing `import type` lines):
```ts
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";
import { selectTopCandidates } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";
```

Then append this function to the end of the file:
```ts
// Select the rep's top candidate ideas, DM them the digest with "Draft this"
// buttons, and record what was sent. Sends whatever is available (1-3); if the
// pool is empty it sends nothing and records nothing, returning ideaCount: 0.
export async function assembleAndDeliver(
  profile: Profile,
): Promise<{ ideaCount: number; messageTs: string | null }> {
  const ideas = await selectTopCandidates(profile.id, 3);
  if (ideas.length === 0) return { ideaCount: 0, messageTs: null };

  const blocks = buildDigestBlocks(ideas);
  const fallback = `You have ${ideas.length} content idea${ideas.length === 1 ? "" : "s"} ready.`;

  // Open (or reuse) the bot↔rep DM, then post the digest there.
  const opened = await slack.conversations.open({ users: profile.slack_user_id });
  const channel = opened.channel?.id;
  if (!channel) throw new Error("could not open DM channel for rep");

  const posted = await slack.chat.postMessage({ channel, blocks, text: fallback });
  const messageTs = posted.ts ?? null;

  // Record the delivery. idea ids are non-null here (rows came from the DB).
  const { error } = await scaClient().from("sca_digests").insert({
    rep_id: profile.id,
    idea_ids: ideas.map((i) => i.id),
    message_ts: messageTs,
  });
  if (error) throw error;

  return { ideaCount: ideas.length, messageTs };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Re-run `npm test -- digest` → the Task 1 tests still pass (this task added no pure logic). Live behavior is proven in Task 4 — it needs real secrets.

- [ ] **Step 3: Commit**

```bash
git add lib/digest.ts
git commit -m "feat(sca): assembleAndDeliver — post digest DM + record sca_digests"
```

---

### Task 3: `POST /api/digest/generate` route

Thin route mirroring `/api/pool/refill`: fail-closed auth, parse `slackUserId`, resolve the profile fresh, require `active`, call `assembleAndDeliver`, return the summary.

**Files:**
- Create: `app/api/digest/generate/route.ts`

**Interfaces:**
- Consumes: `getProfileBySlackUser` (profiles), `assembleAndDeliver` (Task 2).
- Produces: `POST /api/digest/generate` — body `{ slackUserId: string }` → `200 { repId, ideaCount, messageTs }`, `400` bad json / missing id, `401` bad key, `404` no profile, `409` not active.

- [ ] **Step 1: Implement the route**

Create `app/api/digest/generate/route.ts`:
```ts
import { getProfileBySlackUser } from "@/lib/profiles";
import { assembleAndDeliver } from "@/lib/digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Slack DM round-trip + DB write

export async function POST(req: Request) {
  // Internal endpoint — gate behind a shared secret, fail closed.
  const key = process.env.SCA_INTERNAL_KEY;
  if (!key) return Response.json({ error: "not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${key}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const slackUserId = (body as { slackUserId?: unknown })?.slackUserId;
  if (typeof slackUserId !== "string" || slackUserId.length === 0) {
    return Response.json({ error: "missing slackUserId" }, { status: 400 });
  }

  // Resolve the rep fresh from the request — never trust a client-supplied id.
  const profile = await getProfileBySlackUser(slackUserId);
  if (!profile) return new Response("not found", { status: 404 });
  if (profile.status !== "active") {
    return Response.json({ error: "profile not active" }, { status: 409 });
  }

  const { ideaCount, messageTs } = await assembleAndDeliver(profile);
  return Response.json({ repId: profile.id, ideaCount, messageTs });
}
```

- [ ] **Step 2: Typecheck and build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: typecheck clean; build succeeds. `/api/digest/generate` appears as a dynamic (ƒ) route in the build output, not statically prerendered (○) — confirming `force-dynamic` took effect and the build never touched Slack/DB.

- [ ] **Step 3: Commit**

```bash
git add app/api/digest/generate/route.ts
git diff --cached --name-only    # confirm all under sales-content-assistant/
git commit -m "feat(sca): /api/digest/generate — deliver top-3 digest to the rep's DM"
```

---

### Task 4: Live integration verification

Prove the real Slack + Supabase path for the guinea pig (Trent), the Phase-0 way. No temp route is needed — the endpoint is already callable with the internal key. Requires at least one `candidate` idea in Trent's pool; if the pool is empty, hit `/api/pool/refill` first (same auth) to fill it.

**Files:** none (verification only).

- [ ] **Step 1: Deploy the preview**

Run:
```bash
npm run build && vercel deploy
```
Note the preview URL it prints (`<preview-url>` below).

- [ ] **Step 2: Ensure Trent's pool has candidates**

Trent's Slack id is `U04ECG6KEA3` (the owner id used across prior plans). Refill first so there is something to send:
```bash
curl -sS -X POST "https://<preview-url>/api/pool/refill" \
  -H "authorization: Bearer $SCA_INTERNAL_KEY" \
  -H "content-type: application/json" \
  -d '{"slackUserId":"U04ECG6KEA3"}'
```
Expected: JSON with `inserted` ≥ 0. (If `reason: "no new demos"` and the pool was already filled in a prior session, that is fine — candidates may already exist.)

- [ ] **Step 3: Generate + deliver the digest**

```bash
curl -sS -X POST "https://<preview-url>/api/digest/generate" \
  -H "authorization: Bearer $SCA_INTERNAL_KEY" \
  -H "content-type: application/json" \
  -d '{"slackUserId":"U04ECG6KEA3"}'
```
Expected: `{ "repId": "<uuid>", "ideaCount": 1..3, "messageTs": "<ts>" }`.

- [ ] **Step 4: Verify the DM and the record**

1. In Slack, open the DM from the assistant bot. Confirm a message reading "Here are a few things worth saying this week." followed by 1-3 ideas, each a bold hook + rationale with a **Draft this** button. Clicking a button does nothing yet (or shows a Slack "failed" hint) because `/api/slack/interactivity` doesn't exist — expected at this step.
2. In the SCA Supabase Table editor, confirm a new `sca_digests` row: `rep_id` matches `repId` from Step 3, `idea_ids` holds the shown ideas' uuids, `message_ts` matches `messageTs`.

Record the observed `ideaCount` and one hook line in the findings doc as evidence the digest delivered.

- [ ] **Step 5: Verify empty-pool behavior (no auth/secret needed beyond the key)**

Call generate a second time only if you want to confirm the dry-pool path *and* the first call drained the pool — otherwise skip. To force it deterministically, target a Slack id with an active profile but no candidates (or re-run after all candidates are consumed). Expected: `{ ideaCount: 0, messageTs: null }` and **no** new `sca_digests` row. (This is a best-effort check; the unit test already pins the shaper's empty case.)

- [ ] **Step 6: Commit the findings note**

If you keep a findings doc for Phase 1, append the observed result. No code changed in this task, so commit only if the findings doc was edited:
```bash
git add docs/superpowers/spikes/   # only if a findings file was updated
git diff --cached --name-only
git commit -m "chore(sca): verify digest generate + deliver live for Trent"
```

---

## Plan Exit Criteria

- `lib/digest.ts` implemented (`buildDigestBlocks` pure + `assembleAndDeliver` I/O); unit tests green; `tsc --noEmit` clean; `npm run build` succeeds with `/api/digest/generate` shown as dynamic.
- `POST /api/digest/generate` delivers a top-1..3 digest DM to the rep and records `sca_digests`, gated by `SCA_INTERNAL_KEY`, multi-rep ready (resolves the rep from `slackUserId`).
- Live pass proved for Trent: DM arrives with the correct Block Kit format and "Draft this" buttons carrying `action_id: "draft_this"` + the idea uuid; `sca_digests` row written.
- Empty pool sends nothing and records nothing (`ideaCount: 0`).

## Deferred / carry-forward (deliberate, not gaps)

- **Interactivity endpoint (`/api/slack/interactivity`)** — step 6. Consumes the button contract defined here (`action_id: "draft_this"`, `value: <idea uuid>`). The buttons are inert until it ships.
- **Ranking beyond score-desc** — `selectTopCandidates` already orders by `score desc`; no demo/organic blend quota in v1 (the pool is small at one rep). Revisit if digests skew all-one-source.
- **Weekly cron (`step 8`)** — will call this same endpoint on a schedule. Nothing to change here.
- **Idea status on delivery** — ideas stay `candidate` when digested; they flip to `used` only when the rep clicks "Draft this" (step 6). A digested-but-never-drafted idea can appear in a later digest — acceptable and intended (gentle re-surfacing).
