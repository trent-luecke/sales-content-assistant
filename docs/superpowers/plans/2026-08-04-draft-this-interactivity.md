# "Draft this" Interactivity + Draft Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a rep clicks "Draft this" on a digest idea, generate a voice-conditioned, anonymized first-draft post, drop it into a Slack Canvas in their DM, open an iteration thread, and record the session in `sca_thread_map`.

**Architecture:** Four focused units — a generation lib (`lib/generation.ts`: pure prompt/redaction/forbidden-name helpers + a `generateDraft` driver owning the regenerate-then-redact guardrail loop), a Canvas helper (`lib/slack/canvas.ts`), an orchestration lib (`lib/draft.ts`: `handleDraftThis` run inside `waitUntil`), and a thin interactivity route. A source-moment read is added to `lib/mining.ts` and an atomic `claimIdea` to `lib/ideas.ts`. Pure logic is unit-tested; Slack/RAG/AI I/O is verified on one live Vercel deploy (the Phase-0 pattern).

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, `@slack/web-api` (Canvas + messaging), Vercel AI SDK (`ai` `generateText` + `@ai-sdk/anthropic`, model `claude-sonnet-5`), `@supabase/supabase-js`, Vitest.

## Global Constraints

- Project root: `/Users/trentluecke/dev/Claude-Projects/sales-content-assistant` (inside the `Claude-Projects` monorepo — never `git add -A`; stage only this subdir and confirm with `git diff --cached --name-only`).
- Runtime: Node.js (Vercel default). Language: TypeScript, App Router only.
- **Next.js 16:** route handlers are `export async function POST(req: Request)`. Mark the route `export const dynamic = "force-dynamic"` and `export const maxDuration = 120`.
- Model: `claude-sonnet-5` via `@ai-sdk/anthropic`, used through the AI SDK `generateText` (matches `lib/slack/handle-event.ts`). `generateText` returns `{ text }`.
- Secrets never land in local files (env redaction writes `[SENSITIVE]`) — all secret-using code is verified on a Vercel deploy, not a local script. Unit tests mock or avoid all I/O.
- **Hard anonymization rule** (highest-stakes surface — the actual post): generated draft text must never name a customer, prospect, company, or deal. Enforced by prompt rule + second-pass `containsAny` + regenerate-once + `redact` fail-safe.
- Isolation: no module-global mutable *rep* state. `handleDraftThis` resolves the rep fresh from `payload.user.id`; the client never supplies a `rep_id`; every read/write is keyed by rep.
- Security boundary is **Slack signature verification** (`verifySlackSignature`), not Vercel Auth — Vercel Deployment Protection stays OFF so Slack can reach the endpoint.
- **Interactivity payloads are form-encoded** (`application/x-www-form-urlencoded`, a single `payload` field holding JSON) — NOT raw JSON like `/api/slack/events`.
- Button contract (shipped in step 5): `action_id` is `DRAFT_THIS_ACTION = "draft_this"` (exported from `lib/digest.ts`); `value` is the idea uuid.
- Canvas: create via `slack.conversations.canvases.create({ channel_id, title, document_content: { type: "markdown", markdown } })` (response `.canvas_id`); edit via `slack.canvases.edit({ canvas_id, changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }] })`.
- Redaction token is the literal string `[someone]` (role-agnostic).
- Test file convention: `lib/__tests__/<name>.test.ts` (and `lib/slack/__tests__/<name>.test.ts` for slack libs); vitest `environment: node`, alias `@` → repo root, `include: ["**/__tests__/**/*.test.ts"]`.

## Consumed existing interfaces (verbatim — do not re-implement)

From `lib/ideas.ts`:
- `interface Idea { id?: string; rep_id: string; source: "demo"|"organic"; source_ref: Record<string, unknown>; hook: string; rationale: string; score: number; status?: "candidate"|"used"|"rejected"; }`
- `setIdeaStatus(ideaId: string, status: "candidate"|"used"|"rejected"): Promise<void>`

From `lib/profiles.ts`:
- `interface Profile { id: string; avoma_rep_name: string; slack_user_id: string; magic_token: string; display_name: string | null; voice_traits: unknown[]; background: string | null; angle: string | null; channels: unknown[]; admired_post: string | null; status: "draft"|"active"; }`
- `getProfileBySlackUser(slackUserId: string): Promise<Profile | null>`

From `lib/guardrail.ts`:
- `containsAny(text: string, names: string[]): string | null` — first forbidden name found (case-insensitive, word-boundary), else null.

From `lib/supabase.ts`: `scaClient(): SupabaseClient`, `ragReadClient(): SupabaseClient`.
From `lib/slack/client.ts`: `slack: WebClient`.
From `lib/slack/verify.ts`: `verifySlackSignature({ signingSecret, signature, timestamp, rawBody, now? }): boolean`.
From `lib/digest.ts`: `DRAFT_THIS_ACTION` (the string `"draft_this"`).

---

### Task 1: `lib/generation.ts` — pure helpers (`DemoMoment`, `forbiddenNames`, `redact`, `buildDraftPrompt`)

The unit-testable core of generation: the `DemoMoment` type, the forbidden-name list, the redactor, and the prompt builder. No I/O.

**Files:**
- Create: `lib/generation.ts`
- Test: `lib/__tests__/generation.test.ts`

**Interfaces:**
- Consumes: `Idea` (`lib/ideas`), `Profile` (`lib/profiles`).
- Produces: `interface DemoMoment { title: string; repTurns: string[]; speakers: string[]; repFirstName: string }`; `forbiddenNames(moment: DemoMoment): string[]`; `redact(text: string, names: string[]): string`; `buildDraftPrompt(idea: Idea, profile: Profile, moment: DemoMoment | null): string`. `DemoMoment` is imported by `lib/mining.ts` (Task 3) and `generateDraft` (Task 2); the helpers are consumed by `generateDraft`.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/generation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  forbiddenNames,
  redact,
  buildDraftPrompt,
  type DemoMoment,
} from "@/lib/generation";
import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

const moment = (over: Partial<DemoMoment> = {}): DemoMoment => ({
  title: "Gretchen Collins and Chris Reynolds",
  repTurns: ["So here's how I'd run the demo…", "Beautiful."],
  speakers: ["Chris", "Gretchen Collins", "Trent"],
  repFirstName: "Trent",
  ...over,
});

const idea = (over: Partial<Idea> = {}): Idea => ({
  id: "idea-1",
  rep_id: "rep-1",
  source: "demo",
  source_ref: { meetingId: "m1" },
  hook: "The moment a demo lands is when I go quiet",
  rationale: "contrarian, teaches a method",
  score: 0,
  status: "candidate",
  ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: "rep-1",
  avoma_rep_name: "Trent Luecke",
  slack_user_id: "U04ECG6KEA3",
  magic_token: "tok",
  display_name: "Trent",
  voice_traits: [{ name: "Direct", description: "no fluff", examples: ["Beautiful."] }],
  background: "ex-coach",
  angle: "outsider who makes it approachable",
  channels: ["LinkedIn"],
  admired_post: "some admired post",
  status: "active",
  ...over,
});

describe("forbiddenNames", () => {
  it("unions title names and non-rep speakers, excluding the rep", () => {
    const names = forbiddenNames(moment());
    expect(names).toContain("Gretchen Collins");
    expect(names).toContain("Chris Reynolds");
    expect(names).toContain("Chris");
    // rep's own name is never forbidden
    expect(names).not.toContain("Trent");
  });
  it("excludes the rep even when a speaker label is the rep's full name", () => {
    const names = forbiddenNames(moment({ speakers: ["Trent Luecke", "Dana"] }));
    expect(names).not.toContain("Trent Luecke");
    expect(names).toContain("Dana");
  });
  it("dedupes case-insensitively", () => {
    const names = forbiddenNames(moment({ title: "Chris", speakers: ["chris", "CHRIS"] }));
    expect(names.filter((n) => n.toLowerCase() === "chris")).toHaveLength(1);
  });
});

describe("redact", () => {
  it("replaces a forbidden name with the neutral token", () => {
    expect(redact("Great chat with Gretchen today", ["Gretchen"])).toBe(
      "Great chat with [someone] today",
    );
  });
  it("is case-insensitive and leaves the possessive apostrophe attached", () => {
    expect(redact("gretchen's crew loved it", ["Gretchen"])).toBe("[someone]'s crew loved it");
  });
  it("does not touch a name embedded in another word", () => {
    expect(redact("the according plan", ["Acme"])).toBe("the according plan");
    expect(redact("Acme shipped", ["Acme"])).toBe("[someone] shipped");
  });
  it("leaves clean text untouched", () => {
    expect(redact("a strength coach I met", ["Gretchen", "Acme"])).toBe(
      "a strength coach I met",
    );
  });
});

describe("buildDraftPrompt", () => {
  it("includes voice traits, the hook, the rationale, and the anonymization rule", () => {
    const p = buildDraftPrompt(idea(), profile(), moment());
    expect(p).toContain("Direct");
    expect(p).toContain("The moment a demo lands is when I go quiet");
    expect(p).toContain("outsider who makes it approachable");
    expect(p.toLowerCase()).toContain("never name");
  });
  it("includes the demo moment's rep turns for demo ideas", () => {
    const p = buildDraftPrompt(idea(), profile(), moment());
    expect(p).toContain("So here's how I'd run the demo");
  });
  it("omits the moment section for organic ideas (moment null)", () => {
    const p = buildDraftPrompt(idea({ source: "organic", source_ref: {} }), profile(), null);
    expect(p).not.toContain("So here's how I'd run the demo");
    // still voice-conditioned and rule-bound
    expect(p).toContain("Direct");
    expect(p.toLowerCase()).toContain("never name");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- generation`
Expected: FAIL — `@/lib/generation` not found.

- [ ] **Step 3: Implement the pure helpers**

Create `lib/generation.ts`:
```ts
import type { Idea } from "@/lib/ideas";
import type { Profile } from "@/lib/profiles";

export interface DemoMoment {
  title: string;
  repTurns: string[];
  speakers: string[];
  repFirstName: string;
}

interface VoiceTraitish {
  name?: string;
  description?: string;
  examples?: string[];
}

// Split a demo title into candidate names. Titles look like
// "Gretchen Collins and Chris Reynolds" or "Bre / Trent".
function splitTitleNames(title: string): string[] {
  return title
    .split(/\s+(?:and|&|\/|,|\||with|x)\s+|\s*[/|]\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The names that must never appear in rep-facing copy: title names ∪ the
// distinct non-rep speaker labels in the transcript (the actual people in the
// room), with the rep's own name removed. Deduped case-insensitively.
export function forbiddenNames(moment: DemoMoment): string[] {
  const rep = moment.repFirstName.trim().toLowerCase();
  const isRep = (n: string) => {
    const l = n.toLowerCase();
    return l === rep || (rep.length > 0 && l.startsWith(rep + " "));
  };
  const candidates = [...splitTitleNames(moment.title), ...moment.speakers]
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && !isRep(s));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of candidates) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

// Replace each forbidden name (case-insensitive, word-boundary) with a neutral
// token. A trailing possessive apostrophe survives ("Gretchen's" -> "[someone]'s")
// because the boundary lookahead treats the apostrophe as a non-word char.
export function redact(text: string, names: string[]): string {
  let out = text;
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 1) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "gi");
    out = out.replace(re, "[someone]");
  }
  return out;
}

function renderTraits(traits: unknown[]): string {
  const list = (traits as VoiceTraitish[]) ?? [];
  return list
    .map((t) => {
      const ex = (t.examples ?? []).map((e) => `    - "${e}"`).join("\n");
      return `- ${t.name ?? "trait"}: ${t.description ?? ""}${ex ? `\n${ex}` : ""}`;
    })
    .join("\n");
}

// Assemble the voice-conditioned drafting prompt. Pure string building — the
// model call lives in generateDraft.
export function buildDraftPrompt(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
): string {
  const parts: string[] = [];
  parts.push(
    "Write a single social post (LinkedIn/Instagram) in this sales rep's own voice. " +
      "First person, natural, no hashtags unless the rep's examples use them. Return ONLY the post text.",
  );
  parts.push(
    "HARD RULE: never name a customer, prospect, company, club, or deal. Render every " +
      "story as an anonymized pattern (e.g. 'a strength coach I spoke with'). If you are " +
      "unsure whether something identifies a real party, generalize it.",
  );
  parts.push(`## The rep's voice\n${renderTraits(profile.voice_traits)}`);
  if (profile.background) parts.push(`## Background\n${profile.background}`);
  if (profile.angle) parts.push(`## Their distinctive angle\n${profile.angle}`);
  if (profile.admired_post) parts.push(`## A post they admire (echo the style, not the content)\n${profile.admired_post}`);
  parts.push(`## What to say\nHook: ${idea.hook}\nWhy it lands: ${idea.rationale}`);
  if (moment) {
    parts.push(
      `## The moment (from a real demo — anonymize any names before writing)\n` +
        moment.repTurns.join("\n"),
    );
  }
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- generation`
Expected: PASS (all describe blocks green). Also run `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/generation.ts lib/__tests__/generation.test.ts
git diff --cached --name-only    # confirm all under sales-content-assistant/
git commit -m "feat(sca): generation pure helpers — forbiddenNames, redact, buildDraftPrompt"
```

---

### Task 2: `generateDraft` — the guardrail loop (regenerate once, then redact)

Append the I/O driver to `lib/generation.ts`: run the model, second-pass check, regenerate once on a leak, redact as fail-safe. The model is mocked in the test (no secrets), which lets us unit-test the full guardrail loop.

**Files:**
- Modify: `lib/generation.ts` (append; keep Task 1 exports intact)
- Modify: `lib/__tests__/generation.test.ts` (append a `describe("generateDraft")` block)

**Interfaces:**
- Consumes: `containsAny` (`lib/guardrail`), `forbiddenNames`/`redact`/`buildDraftPrompt` (Task 1), `generateText` (`ai`), `anthropic` (`@ai-sdk/anthropic`).
- Produces: `generateDraft(idea: Idea, profile: Profile, moment: DemoMoment | null): Promise<{ body: string; wasRedacted: boolean }>`. Consumed by `lib/draft.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/generation.test.ts`. First **edit the existing imports** (do NOT add duplicate import lines — that's a duplicate-binding error):
- Change `import { describe, it, expect } from "vitest";` to `import { describe, it, expect, vi, beforeEach } from "vitest";`
- Change `import { forbiddenNames, redact, buildDraftPrompt, type DemoMoment } from "@/lib/generation";` to also import `generateDraft`: `import { forbiddenNames, redact, buildDraftPrompt, generateDraft, type DemoMoment } from "@/lib/generation";`
- Add one new import line with the others: `import { generateText } from "ai";`

Then add the AI-SDK mock (a single top-level statement below the imports — vitest hoists `vi.mock` above the imports automatically, so the mock is registered before `ai` is loaded) and the `describe` block at the end:
```ts
// Mock the AI SDK so no network/secret is needed; each test scripts the outputs.
vi.mock("ai", () => ({ generateText: vi.fn() }));

describe("generateDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the draft unchanged when the first pass is clean", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "a strength coach I met loved it" } as any);
    const res = await generateDraft(idea(), profile(), moment());
    expect(res).toEqual({ body: "a strength coach I met loved it", wasRedacted: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("regenerates once when a name leaks, and returns the clean retry", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Chris and I nailed the demo" } as any) // leaks "Chris"
      .mockResolvedValueOnce({ text: "a coach and I nailed the demo" } as any); // clean
    const res = await generateDraft(idea(), profile(), moment());
    expect(res.wasRedacted).toBe(false);
    expect(res.body).toBe("a coach and I nailed the demo");
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("redacts as a fail-safe when the retry still leaks", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Chris crushed it" } as any)
      .mockResolvedValueOnce({ text: "Chris still crushed it" } as any); // still leaks
    const res = await generateDraft(idea(), profile(), moment());
    expect(res.wasRedacted).toBe(true);
    expect(res.body).toBe("[someone] still crushed it");
    expect(res.body).not.toMatch(/Chris/);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("does not check names for organic ideas (empty forbidden list)", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Big Company energy today" } as any);
    const res = await generateDraft(idea({ source: "organic", source_ref: {} }), profile(), null);
    expect(res).toEqual({ body: "Big Company energy today", wasRedacted: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- generation`
Expected: FAIL — `generateDraft` is not exported.

- [ ] **Step 3: Implement `generateDraft`**

Add these imports to the top of `lib/generation.ts` (below the existing `import type` lines):
```ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { containsAny } from "@/lib/guardrail";
```
Then append to the end of `lib/generation.ts`:
```ts
const MODEL = anthropic("claude-sonnet-5");

// Generate a first-draft post in the rep's voice with the anonymization guardrail
// enforced: model call -> second-pass name check -> regenerate once if a name
// leaked -> redact as a last resort. For organic ideas (moment null) the forbidden
// list is empty and the checks are no-ops (inputs are already anonymized).
export async function generateDraft(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
): Promise<{ body: string; wasRedacted: boolean }> {
  const forbidden = moment ? forbiddenNames(moment) : [];
  const basePrompt = buildDraftPrompt(idea, profile, moment);

  let { text } = await generateText({ model: MODEL, prompt: basePrompt });
  let leaked = containsAny(text, forbidden);

  if (leaked) {
    const retryPrompt =
      basePrompt +
      `\n\nA prior draft included the name "${leaked}". Do NOT mention "${leaked}" or any ` +
      `other real person, company, or client. Rewrite the post fully anonymized.`;
    ({ text } = await generateText({ model: MODEL, prompt: retryPrompt }));
    leaked = containsAny(text, forbidden);
  }

  let wasRedacted = false;
  if (leaked) {
    text = redact(text, forbidden);
    wasRedacted = true;
  }

  return { body: text, wasRedacted };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- generation`
Expected: PASS (Task 1 blocks + the 4 `generateDraft` cases). Also `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/generation.ts lib/__tests__/generation.test.ts
git commit -m "feat(sca): generateDraft — voice draft with regenerate-then-redact guardrail"
```

---

### Task 3: `readDemoMoment` — source-moment read from the RAG

Add an I/O reader to `lib/mining.ts` that pulls a single demo's rep turns + speaker labels for grounding + the forbidden-name list. No unit test (needs real RAG + secrets), verified live in Task 8 — matches `readRepDemos`.

**Files:**
- Modify: `lib/mining.ts` (append; import the `DemoMoment` type from `lib/generation`)

**Interfaces:**
- Consumes: `ragReadClient` (`lib/supabase`), `DemoMoment` (`lib/generation`, Task 1).
- Produces: `readDemoMoment(meetingId: string): Promise<DemoMoment | null>`. Consumed by `lib/draft.ts` (Task 6).

- [ ] **Step 1: Implement `readDemoMoment`**

Add this import near the top of `lib/mining.ts` (with the other imports):
```ts
import type { DemoMoment } from "@/lib/generation";
```
Append to the end of `lib/mining.ts`:
```ts
// Read one demo's moment from the RAG (read-only) for drafting: the rep's own
// turns (for grounding) plus the distinct non-empty speaker labels (for the
// forbidden-name list). Mirrors readRepDemos' two-query shape. null if missing.
export async function readDemoMoment(meetingId: string): Promise<DemoMoment | null> {
  const rag = ragReadClient();
  const { data: meeting, error } = await rag
    .from("meetings")
    .select("id,title,rep_name")
    .eq("id", meetingId)
    .maybeSingle();
  if (error) throw error;
  if (!meeting) return null;
  const m = meeting as { title?: string; rep_name?: string };

  const { data: chunks, error: cErr } = await rag
    .from("chunks")
    .select("speaker,text,chunk_index")
    .eq("meeting_id", meetingId)
    .order("chunk_index", { ascending: true });
  if (cErr) throw cErr;
  const rows = (chunks ?? []) as { speaker?: string; text?: string }[];

  const repFirstName = (m.rep_name ?? "").split(/\s+/)[0] ?? "";
  const repFirst = repFirstName.toLowerCase();

  const repTurns: string[] = [];
  const speakerSet = new Set<string>();
  for (const c of rows) {
    const speaker = typeof c.speaker === "string" ? c.speaker : "";
    const text = typeof c.text === "string" ? c.text : "";
    const isRep = speaker.toLowerCase().includes(repFirst) && repFirst.length > 0;
    if (isRep) {
      if (text) repTurns.push(text);
    } else if (speaker) {
      speakerSet.add(speaker);
    }
  }

  return {
    title: m.title ?? "",
    repTurns: repTurns.slice(0, 400),
    speakers: [...speakerSet],
    repFirstName,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Live behavior proven in Task 8 — needs real secrets.)

- [ ] **Step 3: Commit**

```bash
git add lib/mining.ts
git commit -m "feat(sca): readDemoMoment — RAG read of a demo's turns + speakers for drafting"
```

---

### Task 4: `claimIdea` + `classifyClaim` — atomic double-click-safe claim

Add an atomic claim to `lib/ideas.ts`. A conditional UPDATE (`WHERE status='candidate'`) is the guard; a pure `classifyClaim` maps the two DB reads to one of three outcomes so the orchestration can branch (and is unit-tested).

**Files:**
- Modify: `lib/ideas.ts` (append)
- Test: `lib/__tests__/ideas.test.ts` (append a `describe("classifyClaim")` block)

**Interfaces:**
- Consumes: `scaClient` (`lib/supabase`), `Idea` (same file).
- Produces: `type ClaimResult = { outcome: "claimed"; idea: Idea } | { outcome: "already_used"; idea: Idea } | { outcome: "not_found" }`; `classifyClaim(claimed: Idea | null, existing: Idea | null): ClaimResult`; `claimIdea(ideaId: string, repId: string): Promise<ClaimResult>`. Consumed by `lib/draft.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/ideas.test.ts` (add `classifyClaim` and `type Idea` to the existing import from `@/lib/ideas` if not already present):
```ts
import { classifyClaim } from "@/lib/ideas";

const anIdea = (over: Partial<Idea> = {}): Idea => ({
  id: "i1", rep_id: "r1", source: "demo", source_ref: {}, hook: "h", rationale: "", score: 0, ...over,
});

describe("classifyClaim", () => {
  it("claimed when the conditional update returned a row", () => {
    const claimed = anIdea({ status: "used" });
    expect(classifyClaim(claimed, null)).toEqual({ outcome: "claimed", idea: claimed });
  });
  it("already_used when nothing was claimed but the idea exists for the rep", () => {
    const existing = anIdea({ status: "used" });
    expect(classifyClaim(null, existing)).toEqual({ outcome: "already_used", idea: existing });
  });
  it("not_found when neither a claim nor an existing idea is present", () => {
    expect(classifyClaim(null, null)).toEqual({ outcome: "not_found" });
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- ideas`
Expected: FAIL — `classifyClaim` not exported.

- [ ] **Step 3: Implement**

Append to `lib/ideas.ts`:
```ts
export type ClaimResult =
  | { outcome: "claimed"; idea: Idea }
  | { outcome: "already_used"; idea: Idea }
  | { outcome: "not_found" };

// Pure: map the two reads (the conditional-claim result and a plain lookup) to
// an outcome. Kept separate from the DB calls so the branching is unit-tested.
export function classifyClaim(claimed: Idea | null, existing: Idea | null): ClaimResult {
  if (claimed) return { outcome: "claimed", idea: claimed };
  if (existing) return { outcome: "already_used", idea: existing };
  return { outcome: "not_found" };
}

// Atomically claim a candidate idea for drafting. The conditional UPDATE
// (status='candidate' guard) is the double-click race guard: only one caller can
// flip it to 'used'. On a miss, a scoped lookup distinguishes already-drafted
// from not-found/wrong-rep (the latter also enforces cross-rep isolation).
export async function claimIdea(ideaId: string, repId: string): Promise<ClaimResult> {
  const sca = scaClient();
  const { data: claimed, error } = await sca
    .from("sca_ideas")
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", ideaId)
    .eq("rep_id", repId)
    .eq("status", "candidate")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (claimed) return classifyClaim(claimed as Idea, null);

  const { data: existing, error: rErr } = await sca
    .from("sca_ideas")
    .select("*")
    .eq("id", ideaId)
    .eq("rep_id", repId)
    .maybeSingle();
  if (rErr) throw rErr;
  return classifyClaim(null, (existing as Idea) ?? null);
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- ideas`
Expected: PASS (existing ideas tests + the 3 `classifyClaim` cases). Also `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/ideas.ts lib/__tests__/ideas.test.ts
git commit -m "feat(sca): claimIdea — atomic candidate claim + classifyClaim outcome mapping"
```

---

### Task 5: `lib/slack/canvas.ts` — Canvas create + edit helpers

Thin wrappers over the Spike-B-proven Canvas mechanics. `createCanvasInDM` is used in Task 6; `editCanvas` is built now (Canvas home complete) and first used live in step 7. I/O only — typecheck here, verified live in Task 8 / step 7.

**Files:**
- Create: `lib/slack/canvas.ts`

**Interfaces:**
- Consumes: `slack` (`lib/slack/client`).
- Produces: `createCanvasInDM(channel: string, title: string, markdown: string): Promise<string>` (returns `canvas_id`); `editCanvas(canvasId: string, markdown: string): Promise<void>`. Consumed by `lib/draft.ts` (Task 6) and step 7.

- [ ] **Step 1: Implement the helpers**

Create `lib/slack/canvas.ts`:
```ts
import { slack } from "@/lib/slack/client";

// Create a Canvas attached to the rep's DM (renders inline). Spike B verified
// conversations.canvases.create is the path that opens for the user; the
// standalone canvases.create + link path does NOT. Returns the canvas id.
export async function createCanvasInDM(
  channel: string,
  title: string,
  markdown: string,
): Promise<string> {
  const res = await slack.conversations.canvases.create({
    channel_id: channel,
    title,
    document_content: { type: "markdown", markdown },
  });
  const id = res.canvas_id;
  if (!id) throw new Error("conversations.canvases.create returned no canvas_id");
  return id;
}

// Replace the whole Canvas document in place (Spike B: full-document replace
// updates the same canvas, no new one spawned). Used by the iteration loop (step 7).
export async function editCanvas(canvasId: string, markdown: string): Promise<void> {
  await slack.canvases.edit({
    canvas_id: canvasId,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Live behavior proven in Task 8 for create; step 7 for edit.)

- [ ] **Step 3: Commit**

```bash
git add lib/slack/canvas.ts
git commit -m "feat(sca): slack canvas helpers — createCanvasInDM + editCanvas (replace)"
```

---

### Task 6: `lib/draft.ts` — `handleDraftThis` orchestration

The orchestration run inside `waitUntil`: resolve the rep, atomically claim the idea, load the moment, generate, create the Canvas, post the thread opener, write `sca_thread_map`. Owns all failure handling (releases the claim on error). I/O — verified live in Task 8 (matches `handle-event.ts`, which has no unit test).

**Files:**
- Create: `lib/draft.ts`

**Interfaces:**
- Consumes: `getProfileBySlackUser` (profiles), `claimIdea`/`setIdeaStatus` (ideas), `readDemoMoment` (mining), `generateDraft` (generation), `createCanvasInDM` (slack/canvas), `slack` (slack/client), `scaClient` (supabase).
- Produces: `handleDraftThis(payload: unknown): Promise<void>`. Consumed by the route (Task 7).

- [ ] **Step 1: Implement the orchestration**

Create `lib/draft.ts`:
```ts
import { getProfileBySlackUser } from "@/lib/profiles";
import { claimIdea, setIdeaStatus } from "@/lib/ideas";
import { readDemoMoment } from "@/lib/mining";
import { generateDraft } from "@/lib/generation";
import { createCanvasInDM } from "@/lib/slack/canvas";
import { slack } from "@/lib/slack/client";
import { scaClient } from "@/lib/supabase";

const OPENER = "First cut's in the canvas above — tell me what to change and I'll rework it.";
const REDACTED_NOTE =
  "\n\n⚠️ Heads up — I had to redact a name to keep this anonymous, so one phrase might " +
  "read a little awkwardly. Worth a quick look before you post.";

// A short Canvas title from the idea's hook.
function draftTitle(hook: string): string {
  const h = hook.trim();
  return h.length > 60 ? `${h.slice(0, 57)}…` : h;
}

// Post a message, optionally in a thread. Never throws (best-effort signal).
async function safePost(channel: string, threadTs: string | undefined, text: string): Promise<void> {
  try {
    await slack.chat.postMessage({ channel, thread_ts: threadTs, text });
  } catch (e) {
    console.error("safePost failed", { channel, error: e });
  }
}

// The thread_ts of the rep's existing draft session for an idea, if any.
async function threadTsForIdea(repId: string, ideaId: string): Promise<string | undefined> {
  const { data } = await scaClient()
    .from("sca_thread_map")
    .select("thread_ts")
    .eq("rep_id", repId)
    .eq("idea_id", ideaId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.thread_ts as string | undefined) ?? undefined;
}

// Handle a "Draft this" click end to end. Runs post-ack (inside waitUntil), so it
// owns all failure handling — nothing here can surface an HTTP error to Slack.
export async function handleDraftThis(payload: unknown): Promise<void> {
  const p = payload as {
    actions?: { value?: unknown }[];
    user?: { id?: unknown };
    channel?: { id?: unknown };
  };
  const ideaId = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (typeof ideaId !== "string" || typeof slackUserId !== "string" || typeof channel !== "string") {
    return;
  }

  const profile = await getProfileBySlackUser(slackUserId);
  if (!profile) {
    await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
    return;
  }

  const claim = await claimIdea(ideaId, profile.id);
  if (claim.outcome === "already_used") {
    const existingTs = await threadTsForIdea(profile.id, ideaId);
    await safePost(channel, existingTs, "You're already drafting this one 👆");
    return;
  }
  if (claim.outcome === "not_found") {
    await safePost(channel, undefined, "Hmm, I couldn't find that idea — grab another from your latest digest.");
    return;
  }

  const idea = claim.idea;
  try {
    const meetingId =
      typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
        ? ((idea.source_ref as { meetingId: string }).meetingId)
        : null;
    const moment = idea.source === "demo" && meetingId ? await readDemoMoment(meetingId) : null;

    const { body, wasRedacted } = await generateDraft(idea, profile, moment);
    const canvasId = await createCanvasInDM(channel, draftTitle(idea.hook), body);

    const posted = await slack.chat.postMessage({
      channel,
      text: wasRedacted ? OPENER + REDACTED_NOTE : OPENER,
    });
    const threadTs = posted.ts;
    if (!threadTs) throw new Error("thread opener returned no ts");

    const { error } = await scaClient().from("sca_thread_map").insert({
      rep_id: profile.id,
      slack_channel: channel,
      thread_ts: threadTs,
      canvas_id: canvasId,
      idea_id: ideaId,
    });
    if (error) throw error;
  } catch (e) {
    // Release the claim so the rep can retry; signal them. Never rethrow (post-ack).
    await setIdeaStatus(ideaId, "candidate").catch(() => {});
    await safePost(channel, undefined, "Something went wrong drafting that — try again in a sec.");
    console.error("handleDraftThis failed", { repId: profile.id, ideaId, error: e });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Also run the full suite once — `npm test` — to confirm nothing regressed (this task added no unit tests but imports several tested libs).

- [ ] **Step 3: Commit**

```bash
git add lib/draft.ts
git commit -m "feat(sca): handleDraftThis — claim, draft, canvas, thread, thread_map (with claim release on failure)"
```

---

### Task 7: `app/api/slack/interactivity/route.ts` — the endpoint

Thin route: verify the Slack signature, parse the form-encoded `payload`, ack in <3s, and hand the "draft_this" action to `handleDraftThis` via `waitUntil`.

**Files:**
- Create: `app/api/slack/interactivity/route.ts`

**Interfaces:**
- Consumes: `verifySlackSignature` (slack/verify), `handleDraftThis` (draft), `DRAFT_THIS_ACTION` (digest), `waitUntil` (`@vercel/functions`).
- Produces: `POST /api/slack/interactivity`.

- [ ] **Step 1: Implement the route**

Create `app/api/slack/interactivity/route.ts`:
```ts
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "@/lib/slack/verify";
import { handleDraftThis } from "@/lib/draft";
import { DRAFT_THIS_ACTION } from "@/lib/digest";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // RAG read + up to two model calls + Canvas create

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  // Interactivity payloads are form-encoded: a single `payload` field holding JSON.
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return new Response(null, { status: 200 });
  let payload: { type?: string; actions?: { action_id?: string }[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 200 });
  }

  if (
    payload.type === "block_actions" &&
    payload.actions?.[0]?.action_id === DRAFT_THIS_ACTION
  ) {
    waitUntil(handleDraftThis(payload)); // ack now, do slow work after responding
  }
  return new Response(null, { status: 200 });
}
```

- [ ] **Step 2: Typecheck and build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: typecheck clean; build succeeds. `/api/slack/interactivity` appears as a dynamic (ƒ) route in the build output.

- [ ] **Step 3: Commit**

```bash
git add app/api/slack/interactivity/route.ts
git diff --cached --name-only    # confirm all under sales-content-assistant/
git commit -m "feat(sca): /api/slack/interactivity — verify, ack, dispatch draft_this"
```

---

### Task 8: Live integration verification

Prove the real Slack + RAG + AI path for Trent, the Phase-0 way. Requires two human console steps (Slack app config) an agent cannot do, then a click-through.

**Files:** none (verification only; note results in `docs/superpowers/spikes/phase-0-findings.md` if desired).

- [ ] **Step 1: Human — Slack app config**

In the Slack app settings (api.slack.com/apps → this app):
1. **Interactivity & Shortcuts** → turn on → set the Request URL to `https://<preview-url>/api/slack/interactivity` (fill in after Step 2's deploy; you may need to deploy first, then set this).
2. **OAuth & Permissions** → confirm the Bot Token Scopes include `canvases:write`. If you add it, **reinstall the app** to the workspace so the token gains the scope.

- [ ] **Step 2: Deploy the preview**

Run:
```bash
npm run build && vercel deploy
```
Note the preview URL. Set the Interactivity Request URL (Step 1.1) to this deploy. (Per Phase 0: preview URLs change per deploy — if you redeploy, update the Slack URL, or alias a stable domain.)

- [ ] **Step 3: Generate a fresh digest with a demo idea**

Ensure Trent's pool has candidates and send a digest (reuses step 5's endpoints):
```bash
URL="https://<preview-url>"; KEY=$(grep -E '^SCA_INTERNAL_KEY=' .env.local | cut -d= -f2-)
curl -sS -X POST "$URL/api/pool/refill"    -H "authorization: Bearer $KEY" -H "content-type: application/json" -d '{"slackUserId":"U04ECG6KEA3"}'
curl -sS -X POST "$URL/api/digest/generate" -H "authorization: Bearer $KEY" -H "content-type: application/json" -d '{"slackUserId":"U04ECG6KEA3"}'
```
Expected: the digest DM arrives with 1-3 ideas, each with a **Draft this** button.

- [ ] **Step 4: Click "Draft this" and verify the draft loop**

In the DM, click **Draft this** on a **demo-sourced** idea. Within ~30s expect, in order:
1. A **Canvas** appears in the DM containing a post written in Trent's voice.
2. A thread opener message posts ("First cut's in the canvas above…"). If the draft required redaction, the ⚠️ note is appended.
3. **Read the Canvas draft and confirm no customer/prospect/company names appear** (the highest-stakes check — real transcript data went into generation). If a name leaked past the guardrail, capture it and harden before proceeding.

- [ ] **Step 5: Verify persistence + double-click**

1. In the SCA Supabase Table editor: `sca_thread_map` has a new row with `rep_id` = Trent's profile id, `idea_id` = the clicked idea, a non-null `canvas_id`, and `thread_ts` = the opener message's ts. The `sca_ideas` row for that idea is now `status='used'`.
2. Click the **same** Draft this button again → a gentle "You're already drafting this one 👆" reply appears (in the existing thread), and **no second Canvas** is created.

- [ ] **Step 6: Record findings and commit (if the findings doc was edited)**

Append the observed result (draft quality note, guardrail held y/n, double-click behavior) to `docs/superpowers/spikes/phase-0-findings.md`. Commit only if that file changed:
```bash
git add docs/superpowers/spikes/phase-0-findings.md
git diff --cached --name-only
git commit -m "chore(sca): verify draft-this interactivity live for Trent (step 6)"
```

---

## Plan Exit Criteria

- `lib/generation.ts` (pure helpers + `generateDraft`), `lib/slack/canvas.ts`, `lib/draft.ts`, `readDemoMoment`, and `claimIdea`/`classifyClaim` implemented; all unit tests green; `tsc --noEmit` clean; `npm run build` succeeds with `/api/slack/interactivity` as a dynamic route.
- The anonymization guardrail is unit-proven (regenerate + redact both exercised with a mocked model) and holds on real transcript data in the live pass.
- Live pass proved for Trent: click "Draft this" → voice-matched, anonymized Canvas draft + thread opener + `sca_thread_map` row; a second click short-circuits with the gentle reply and no duplicate Canvas.
- Double-click safety is atomic (`claimIdea`'s `WHERE status='candidate'`); a mid-flow failure releases the claim back to `candidate`.

## Deferred / carry-forward (deliberate, not gaps)

- **Iteration loop (step 7)** — thread replies → `sca_thread_map` lookup → `editCanvas` in place. `editCanvas` and `generateDraft` are built here and reused there. `/api/slack/events` already handles thread replies (currently a spike echo) and will be extended.
- **Weekly cron (step 8)** — unchanged by this step.
- **Released-claim `used_at`** — releasing a failed claim sets `status='candidate'` but leaves the stale `used_at` (only read for display). Acceptable; revisit if it ever surfaces.
- **Interactivity URL stability** — preview URLs change per deploy; a stable alias/production domain for the Slack Request URL is a deploy-ops nicety, not required for the guinea-pig pass.
