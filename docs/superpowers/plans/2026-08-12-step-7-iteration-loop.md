# Step 7 — In-Thread Iteration Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rep refine a draft in place by clicking preset buttons (Shorter / Punchier / Less salesy / Different angle) under the draft's opener; each click regenerates the post building on the current draft and edits the same canvas.

**Architecture:** Refinement is a Slack block-action, routed through `/api/slack/interactivity` (not the free-form `events` endpoint). Each button's `value` carries `<ideaId>|<platform>` and its `action_id` is `refine:<kind>`, so a click names its target draft with no ambiguity — dissolving the historic `root_ts` / Both-rep mapping dependency. The current draft body is persisted on the `sca_thread_map` row (new nullable `draft_body`) so refinements compound. A new `refineDraft` reuses `generateDraft`'s anonymization guardrail loop.

**Tech Stack:** Next.js (App Router) on Vercel, TypeScript, `@slack/web-api`, Vercel AI SDK (`ai` + `@ai-sdk/anthropic`, model `claude-sonnet-5`), Supabase (`sca_thread_map`), Vitest.

## Global Constraints

- **Never throw post-ack.** Every handler runs inside `waitUntil` after the route already returned 200. All failure paths degrade to an honest Slack message; nothing re-throws. (Copied from every handler in `lib/draft.ts`.)
- **Anonymization is re-enforced on every generation.** Model call → `containsAny` leak check → one retry with the anti-leak addendum → `redact` as last resort. A refined draft is never less anonymized than the first draft.
- **Slack action_id uniqueness.** All buttons within one `actions` block MUST have distinct `action_id`s (the `invalid_blocks` incident). Refine buttons get uniqueness from the `:<kind>` suffix; they intentionally share one `value`.
- **Model id is `claude-sonnet-5`** via the module-level `MODEL` constant in `lib/generation.ts`. Do not introduce a second model.
- **Deploy model** (post-merge, Trent's hand-off): `vercel --prod` CLI **and** `git push origin main` — keep the remote synced (see memory `sca-deployment-model`). Not part of any code task.
- **Baseline: 91 unit tests green, `tsc` clean** before Task 1. Every task ends green.

---

## File Structure

- `db/schema.sql` — mirror the live `draft_body` column (Task 1).
- `lib/generation.ts` — refine kinds/labels/directives, shared guardrail helper, `refineDraft` (Tasks 2). Home of cross-cutting `Platform`/label consts; no import of `digest.ts` (avoids a cycle).
- `lib/digest.ts` — `REFINE_ACTION`, `parseRefineKind`, opener buttons in `buildOpenerBlocks` (Task 3). Imports refine kinds/labels from `generation.ts`.
- `lib/draft.ts` — `readMoment` helper, `draftStateForIdeaPlatform` lookup, `handleRefine`; persist `draft_body` on insert; pass `ideaId` to the opener (Tasks 1, 4).
- `app/api/slack/interactivity/route.ts` — dispatch `refine:*` (Task 5).
- Tests: `lib/__tests__/generation.test.ts` (Task 2), `lib/__tests__/digest.test.ts` (Task 3). `lib/draft.ts` has no unit harness by design — its DB/Slack-bound handlers are live-verified (Task 6), consistent with `handleDraftThis`/`handleDraftRetry`/`currentCanvasId`.

---

## Task 1: Persist the current draft body

Adds the nullable `draft_body` column and starts writing it on every draft insert. The column is inert until Task 4 reads it — this task only makes new drafts refine-ready and mirrors the schema.

**Files:**
- Modify: `db/schema.sql:35-45` (the `sca_thread_map` table)
- Modify: `lib/draft.ts:234-241` (the `draftOnePlatform` insert)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sca_thread_map.draft_body text` (nullable), populated with the assembled body on every successful draft insert.

- [ ] **Step 1: Apply the live migration (Trent runs this in the SCA Supabase SQL editor)**

This is a hand-off step — the executor pauses and asks Trent to run it, exactly like the `platform` column migration. The column is nullable so it is safe to add while the app is live.

```sql
alter table sca_thread_map add column draft_body text;
```

- [ ] **Step 2: Mirror the column in `db/schema.sql`**

In the `create table sca_thread_map (...)` block, add the column after `platform`:

```sql
create table sca_thread_map (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references sca_profiles(id) on delete cascade,
  slack_channel text not null,
  thread_ts text not null,
  canvas_id text,
  platform text check (platform in ('linkedin','instagram')),
  draft_body text,
  idea_id uuid references sca_ideas(id) on delete set null,
  created_at timestamptz default now(),
  unique (slack_channel, thread_ts)
);
```

- [ ] **Step 3: Persist `draft_body` on the draft insert**

In `lib/draft.ts`, `draftOnePlatform`, the `body` variable is already in scope (destructured at the top of the function). Add `draft_body: body` to the insert:

```ts
    const { error } = await scaClient().from("sca_thread_map").insert({
      rep_id: profile.id,
      slack_channel: channel,
      thread_ts: threadTs,
      canvas_id: canvasId,
      idea_id: idea.id,
      platform,
      draft_body: body,
    });
    if (error) throw error;
```

- [ ] **Step 4: Verify the build and suite are clean**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean; all 91 tests PASS (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql lib/draft.ts
git commit -m "feat(sca): persist draft_body on sca_thread_map for step-7 refine

Nullable draft_body column (live migration applied separately). draftOnePlatform
now stores the assembled body so refinements can build on the current draft.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `refineDraft` + shared guardrail helper

Extracts `generateDraft`'s guardrail loop into a reusable helper and adds `refineDraft`, which builds a prompt from the current body + a per-button directive and runs the same anonymization loop. Pure/TDD — no Slack or DB.

**Files:**
- Modify: `lib/generation.ts` (add consts + `runGuarded` + `buildRefinePrompt` + `refineDraft`; refactor `generateDraft`)
- Test: `lib/__tests__/generation.test.ts`

**Interfaces:**
- Consumes: `buildDraftPrompt`, `forbiddenNames`, `redact`, `assembleCanvasBody`, `containsAny`, `MODEL`, `PLATFORM_LABEL` (all existing in `generation.ts`); `Idea`, `Profile`, `DemoMoment`, `Platform`.
- Produces:
  - `type RefineKind = "shorter" | "punchier" | "less_salesy" | "different_angle"`
  - `const REFINE_KINDS: readonly RefineKind[]`
  - `const REFINE_LABEL: Record<RefineKind, string>` — `{ shorter: "Shorter", punchier: "Punchier", less_salesy: "Less salesy", different_angle: "Different angle" }`
  - `buildRefinePrompt(currentBody: string, kind: RefineKind, idea: Idea, profile: Profile, moment: DemoMoment | null, platform: Platform): string`
  - `refineDraft(currentBody: string, kind: RefineKind, idea: Idea, profile: Profile, moment: DemoMoment | null, platform: Platform): Promise<{ body: string; wasRedacted: boolean }>`

- [ ] **Step 1: Write the failing tests**

Add to `lib/__tests__/generation.test.ts`. Import `buildRefinePrompt`, `refineDraft`, `REFINE_KINDS`, `REFINE_LABEL` alongside the existing imports. Reuse the existing `idea()`, `profile()`, `moment()` factories.

```ts
describe("buildRefinePrompt", () => {
  it("carries the base draft prompt, the current draft, and the kind's directive", () => {
    const p = buildRefinePrompt("my current post text", "shorter", idea(), profile(), moment(), "linkedin");
    // base prompt content
    expect(p).toContain("The moment a demo lands is when I go quiet"); // idea hook
    expect(p).toContain("HARD RULE"); // anonymization rule from buildDraftPrompt
    // current draft + directive
    expect(p).toContain("my current post text");
    expect(p.toLowerCase()).toContain("shorter");
    expect(p).toContain("Return ONLY the revised post");
  });

  it("uses a distinct directive for each kind", () => {
    const forKind = (k: (typeof REFINE_KINDS)[number]) =>
      buildRefinePrompt("body", k, idea(), profile(), moment(), "linkedin");
    const punchier = forKind("punchier");
    const lessSalesy = forKind("less_salesy");
    const different = forKind("different_angle");
    expect(punchier).not.toBe(lessSalesy);
    expect(lessSalesy).not.toBe(different);
    expect(punchier.toLowerCase()).toContain("punch");
    expect(lessSalesy.toLowerCase()).toContain("salesy");
    expect(different.toLowerCase()).toContain("angle");
  });
});

describe("refineDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the revised body unchanged when the pass is clean", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "a tighter version" } as any);
    const res = await refineDraft("the long version", "shorter", idea(), profile(), moment(), "linkedin");
    expect(res).toEqual({ body: "a tighter version", wasRedacted: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("regenerates once when a name leaks, and returns the clean retry", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Chris loved the shorter cut" } as any) // leaks "Chris"
      .mockResolvedValueOnce({ text: "a coach loved the shorter cut" } as any); // clean
    const res = await refineDraft("body", "shorter", idea(), profile(), moment(), "linkedin");
    expect(res.wasRedacted).toBe(false);
    expect(res.body).toBe("a coach loved the shorter cut");
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("redacts as a fail-safe when the retry still leaks", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Chris again" } as any)
      .mockResolvedValueOnce({ text: "Chris still here" } as any);
    const res = await refineDraft("body", "punchier", idea(), profile(), moment(), "linkedin");
    expect(res.wasRedacted).toBe(true);
    expect(res.body).not.toMatch(/Chris/);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("assembles the Instagram visual section from the revised output", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "punchy caption\n===VISUAL===\na chalked barbell",
    } as any);
    const res = await refineDraft("old caption", "punchier", idea(), profile(), null, "instagram");
    expect(res.body).toContain("punchy caption");
    expect(res.body).toContain("Visual idea — not part of your caption");
    expect(res.body).toContain("a chalked barbell");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/generation.test.ts`
Expected: FAIL — `buildRefinePrompt`/`refineDraft`/`REFINE_KINDS`/`REFINE_LABEL` are not exported.

- [ ] **Step 3: Add the refine consts, the shared guardrail helper, and refactor `generateDraft`**

In `lib/generation.ts`, just above the existing `generateDraft` (after the `MODEL` constant), add:

```ts
export type RefineKind = "shorter" | "punchier" | "less_salesy" | "different_angle";

export const REFINE_KINDS: readonly RefineKind[] = [
  "shorter",
  "punchier",
  "less_salesy",
  "different_angle",
];

export const REFINE_LABEL: Record<RefineKind, string> = {
  shorter: "Shorter",
  punchier: "Punchier",
  less_salesy: "Less salesy",
  different_angle: "Different angle",
};

const REFINE_DIRECTIVE: Record<RefineKind, string> = {
  shorter:
    "Make this noticeably shorter and tighter — cut anything that isn't pulling its weight, " +
    "but keep the core point and the rep's voice.",
  punchier:
    "Make this punchier — a sharper opening line, stronger verbs, more energy — without " +
    "changing the core message or the rep's voice.",
  less_salesy:
    "Make this warmer and less salesy — it should read like a person sharing something they " +
    "believe, not a pitch. Keep the substance and the rep's voice.",
  different_angle:
    "Keep the same underlying idea but reframe it from a fresh angle with a new opening — a " +
    "different way in, not a different topic. Keep the rep's voice.",
};
```

Then extract the guardrail loop. Replace the body of `generateDraft` so it delegates to a new `runGuarded`, and add `buildRefinePrompt` + `refineDraft`:

```ts
// The anonymization guardrail loop shared by generateDraft and refineDraft:
// model call -> name leak check -> one regenerate -> redact as a last resort -> assemble.
async function runGuarded(
  prompt: string,
  forbidden: string[],
  platform: Platform,
): Promise<{ body: string; wasRedacted: boolean }> {
  let { text } = await generateText({ model: MODEL, prompt });
  let leaked = containsAny(text, forbidden);

  if (leaked) {
    const retryPrompt =
      prompt +
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

  return { body: assembleCanvasBody(text, platform), wasRedacted };
}

export async function generateDraft(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
  platform: Platform,
): Promise<{ body: string; wasRedacted: boolean }> {
  const forbidden = moment ? forbiddenNames(moment) : [];
  return runGuarded(buildDraftPrompt(idea, profile, moment, platform), forbidden, platform);
}

// Build the refine prompt: the full base draft prompt (voice, platform shape, HARD
// anonymization rule, the moment) + the current draft + the change to make. For
// Instagram the base prompt's ===VISUAL=== contract still governs the fresh output.
export function buildRefinePrompt(
  currentBody: string,
  kind: RefineKind,
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
  platform: Platform,
): string {
  return (
    buildDraftPrompt(idea, profile, moment, platform) +
    `\n\n## The current draft (revise THIS — do not start over)\n${currentBody}` +
    `\n\n## The change to make\n${REFINE_DIRECTIVE[kind]} Return ONLY the revised post text.`
  );
}

// Regenerate a draft applying one refine directive, building on the current body.
// Same guardrail + assembly as generateDraft.
export async function refineDraft(
  currentBody: string,
  kind: RefineKind,
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
  platform: Platform,
): Promise<{ body: string; wasRedacted: boolean }> {
  const forbidden = moment ? forbiddenNames(moment) : [];
  return runGuarded(buildRefinePrompt(currentBody, kind, idea, profile, moment, platform), forbidden, platform);
}
```

Delete the now-duplicated loop that was inline in the old `generateDraft`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/__tests__/generation.test.ts`
Expected: PASS — the new `buildRefinePrompt`/`refineDraft` tests **and** the existing `generateDraft` tests (behavior unchanged by the `runGuarded` refactor).

- [ ] **Step 5: Verify the full suite and build**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean; full suite PASS (91 + new refine tests).

- [ ] **Step 6: Commit**

```bash
git add lib/generation.ts lib/__tests__/generation.test.ts
git commit -m "feat(sca): refineDraft + shared guardrail loop for step-7 iteration

Extracts generateDraft's anonymization loop into runGuarded; adds refineDraft,
buildRefinePrompt, and the RefineKind/REFINE_LABEL/REFINE_DIRECTIVE contract
(Shorter/Punchier/Less salesy/Different angle). Refine re-runs the full guardrail.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Refine buttons under the opener

Adds the four refine buttons to `buildOpenerBlocks`, the `refine:<kind>` action contract, and a `parseRefineKind` helper. Updates the one caller. Pure/TDD.

**Files:**
- Modify: `lib/digest.ts` (`REFINE_ACTION`, `parseRefineKind`, `buildOpenerBlocks` signature + buttons + copy)
- Modify: `lib/draft.ts:223` (pass `idea.id` to `buildOpenerBlocks`)
- Test: `lib/__tests__/digest.test.ts`

**Interfaces:**
- Consumes: `RefineKind`, `REFINE_KINDS`, `REFINE_LABEL` from `lib/generation`; `encodePlatformValue`, `PLATFORM_LABEL`, `REDACTED_NOTE` (existing).
- Produces:
  - `const REFINE_ACTION = "refine"`
  - `parseRefineKind(actionId: string): RefineKind | null` — validates the `refine:<kind>` prefix and known kind.
  - `buildOpenerBlocks(ideaId: string, platform: Platform, opts?: { wasRedacted?: boolean }): KnownBlock[]` — **signature change** (adds `ideaId` first) and now emits an `actions` block.

- [ ] **Step 1: Update the failing tests**

In `lib/__tests__/digest.test.ts`, the existing `describe("buildOpenerBlocks", …)` asserts there is **no** actions block — that expectation is now inverted. Replace that whole describe block, and add a `parseRefineKind` describe. Import `REFINE_ACTION`, `parseRefineKind` (from `@/lib/digest`) and `REFINE_KINDS` (from `@/lib/generation`).

```ts
describe("buildOpenerBlocks", () => {
  it("has a section plus an actions block", () => {
    const blocks = buildOpenerBlocks("idea-1", "linkedin");
    expect(types(blocks)).toEqual(["section", "actions"]);
  });

  it("names the platform in the section copy", () => {
    expect(JSON.stringify(buildOpenerBlocks("idea-1", "instagram"))).toContain("Instagram");
  });

  it("emits one refine button per kind, each with a unique action_id", () => {
    const blocks = buildOpenerBlocks("idea-1", "linkedin");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    expect(actions.elements).toHaveLength(REFINE_KINDS.length);
    const ids = actions.elements.map((e) => e.action_id);
    expect(new Set(ids).size).toBe(REFINE_KINDS.length); // all unique
    for (const id of ids) expect(id.startsWith("refine:")).toBe(true);
  });

  it("every refine button carries the ideaId|platform value", () => {
    const blocks = buildOpenerBlocks("idea-1", "linkedin");
    const actions = blocks.find((b) => b.type === "actions") as { elements: { value: string }[] };
    for (const el of actions.elements) expect(el.value).toBe("idea-1|linkedin");
  });

  it("appends the redaction caveat only when wasRedacted is set", () => {
    const withNote = JSON.stringify(buildOpenerBlocks("idea-1", "linkedin", { wasRedacted: true }));
    const without = JSON.stringify(buildOpenerBlocks("idea-1", "linkedin"));
    expect(withNote).toContain("redact");
    expect(without).not.toContain("redact");
  });
});

describe("parseRefineKind", () => {
  it("returns the kind for a valid refine action_id", () => {
    expect(parseRefineKind("refine:shorter")).toBe("shorter");
    expect(parseRefineKind("refine:different_angle")).toBe("different_angle");
  });
  it("returns null for an unknown kind", () => {
    expect(parseRefineKind("refine:bogus")).toBeNull();
  });
  it("returns null when the prefix is wrong", () => {
    expect(parseRefineKind("draft_this")).toBeNull();
    expect(parseRefineKind("shorter")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/__tests__/digest.test.ts`
Expected: FAIL — `buildOpenerBlocks` has the old signature/no actions block; `REFINE_ACTION`/`parseRefineKind` not exported.

- [ ] **Step 3: Add the refine action contract and rebuild the opener**

In `lib/digest.ts`, add to the imports from `@/lib/generation`:

```ts
import { PLATFORM_LABEL, REFINE_KINDS, REFINE_LABEL } from "@/lib/generation";
import type { Platform, RefineKind } from "@/lib/generation";
```

(Adjust the existing `import type { Platform } from "@/lib/generation";` / `import { PLATFORM_LABEL } …` lines to the above — merge, don't duplicate.)

Add the action constant and parser near the other action constants (after `DRAFT_REPLACE_CANCEL_ACTION`):

```ts
// Refine buttons under a draft opener: action_id is `refine:<kind>`, value is the
// shared "<ideaId>|<platform>" encoding. Each kind gets a unique action_id.
export const REFINE_ACTION = "refine";

export function parseRefineKind(actionId: string): RefineKind | null {
  const prefix = `${REFINE_ACTION}:`;
  if (!actionId.startsWith(prefix)) return null;
  const kind = actionId.slice(prefix.length);
  return (REFINE_KINDS as readonly string[]).includes(kind) ? (kind as RefineKind) : null;
}
```

Replace `buildOpenerBlocks` (the `ideaId` param + actions block + updated copy):

```ts
// The draft's opener message: platform-labeled, with the refine buttons that drive the
// step-7 iteration loop. Each button carries the "<ideaId>|<platform>" value and a
// unique `refine:<kind>` action_id. A new opener is posted per draft; the canvas is reused.
export function buildOpenerBlocks(
  ideaId: string,
  platform: Platform,
  opts?: { wasRedacted?: boolean },
): KnownBlock[] {
  const caveat = opts?.wasRedacted ? REDACTED_NOTE : "";
  const value = encodePlatformValue(ideaId, platform);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Your *${PLATFORM_LABEL[platform]}* draft is in the canvas at the top of this chat. ` +
          `Want a tweak? Tap a button and I'll update the canvas in place.${caveat}`,
      },
    },
    {
      type: "actions",
      elements: REFINE_KINDS.map((kind) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: REFINE_LABEL[kind] },
        action_id: `${REFINE_ACTION}:${kind}`,
        value,
      })),
    },
  ];
}
```

- [ ] **Step 4: Update the one caller**

In `lib/draft.ts`, `draftOnePlatform` (the opener build), pass `idea.id`:

```ts
    const openerBlocks = buildOpenerBlocks(idea.id, platform, { wasRedacted });
```

- [ ] **Step 5: Run tests and build**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean (the `draft.ts` caller now matches the new signature); full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/digest.ts lib/draft.ts lib/__tests__/digest.test.ts
git commit -m "feat(sca): refine buttons on the draft opener (step 7)

buildOpenerBlocks now takes ideaId and emits Shorter/Punchier/Less salesy/
Different angle buttons — unique refine:<kind> action_ids, shared ideaId|platform
value. Adds REFINE_ACTION + parseRefineKind. Opener copy points at the buttons.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `handleRefine` — regenerate and edit in place

The handler: map the click to its draft, regenerate building on the stored body, edit the canvas, persist the new body, confirm in-thread. Never throws post-ack. Live-verified (Task 6), consistent with the other `lib/draft.ts` handlers — the pure mapping it depends on (`parseRefineKind`, `parsePlatformValue`) is already unit-tested in Tasks 2–3.

**Files:**
- Modify: `lib/draft.ts` (imports; `readMoment` helper; `draftStateForIdeaPlatform`; `handleRefine`)

**Interfaces:**
- Consumes: `refineDraft`, `generateDraft`, `REFINE_LABEL` from `@/lib/generation`; `parseRefineKind`, `parsePlatformValue`, `REDACTED_NOTE` from `@/lib/digest`; existing `getIdea`, `readDemoMoment`, `getProfileBySlackUser`, `editCanvas`, `canvasDocument`, `slack`, `scaClient`, `safePost`, `threadRoot`, `PLATFORM_LABEL`.
- Produces: `handleRefine(payload: unknown): Promise<void>` (consumed by Task 5).

- [ ] **Step 1: Extend the imports**

In `lib/draft.ts`, update the two relevant import groups:

```ts
import { generateDraft, refineDraft, canvasName, canvasDocument } from "@/lib/generation";
import type { DemoMoment, Platform } from "@/lib/generation";
import { PLATFORM_LABEL, REFINE_LABEL } from "@/lib/generation";
import {
  parsePlatformValue,
  platformsForSelection,
  parseRefineKind,
  buildPlatformChoiceBlocks,
  buildRetryBlocks,
  buildOpenerBlocks,
  buildReplaceConfirmBlocks,
  REDACTED_NOTE,
} from "@/lib/digest";
```

- [ ] **Step 2: Add a `readMoment` helper (DRY the moment read)**

The `source_ref.meetingId` → `readDemoMoment` dance is repeated in three handlers. Add one helper near `safePost` and use it in the new handler:

```ts
// Read the demo moment behind an idea (for the anonymization forbidden-list), or null
// for organic ideas / on any read failure. Never throws.
async function readMoment(idea: Idea): Promise<DemoMoment | null> {
  const meetingId =
    typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
      ? (idea.source_ref as { meetingId: string }).meetingId
      : null;
  if (idea.source !== "demo" || !meetingId) return null;
  return readDemoMoment(meetingId).catch(() => null);
}
```

- [ ] **Step 3: Add the `(rep, idea, platform)` draft-state lookup**

Add near `currentCanvasId`. Returns the most-recent row's id, canvas, and stored body (or `null` if there is no such row):

```ts
// The most-recent draft session for a specific (rep, idea, platform): its row id, canvas,
// and the stored body a refine will build on. null when no such row exists.
async function draftStateForIdeaPlatform(
  repId: string,
  ideaId: string,
  platform: Platform,
): Promise<{ rowId: string; canvasId: string | null; draftBody: string | null } | null> {
  const { data } = await scaClient()
    .from("sca_thread_map")
    .select("id, canvas_id, draft_body")
    .eq("rep_id", repId)
    .eq("idea_id", ideaId)
    .eq("platform", platform)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    rowId: data.id as string,
    canvasId: (data.canvas_id as string | null) ?? null,
    draftBody: (data.draft_body as string | null) ?? null,
  };
}
```

- [ ] **Step 4: Add `handleRefine`**

Add after `handleDraftRetry` (before the `messageCoords`/`threadRoot` helpers):

```ts
// Handle a "refine:<kind>" click: regenerate this (idea, platform) draft building on the
// stored body, edit the canvas in place, persist the new body, and confirm in-thread.
// Runs post-ack (inside waitUntil); must never throw.
export async function handleRefine(payload: unknown): Promise<void> {
  const p = payload as {
    actions?: { action_id?: unknown; value?: unknown }[];
    user?: { id?: unknown };
    channel?: { id?: unknown };
  };
  const actionId = p?.actions?.[0]?.action_id;
  const rawValue = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (
    typeof actionId !== "string" ||
    typeof rawValue !== "string" ||
    typeof slackUserId !== "string" ||
    typeof channel !== "string"
  ) {
    return;
  }

  const kind = parseRefineKind(actionId);
  const parsed = parsePlatformValue(rawValue);
  if (!kind || !parsed || parsed.selection === "both") return; // refine is single-platform
  const platform: Platform = parsed.selection; // narrowed to "linkedin" | "instagram"

  const rootTs = threadRoot(payload);

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, rootTs, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }

    const state = await draftStateForIdeaPlatform(profile.id, parsed.ideaId, platform);
    if (!state || !state.canvasId) {
      await safePost(channel, rootTs, "That draft's gone — grab a fresh one from your latest digest and I'll tweak that.");
      return;
    }
    const idea = await getIdea(parsed.ideaId, profile.id);
    if (!idea) {
      await safePost(channel, rootTs, "Hmm, I couldn't find that idea — grab another from your latest digest.");
      return;
    }

    const interim = await slack.chat
      .postMessage({ channel, thread_ts: rootTs, text: `↻ Reworking your ${PLATFORM_LABEL[platform]} draft…` })
      .catch(() => null);

    const moment = await readMoment(idea);

    // Build on the stored body. Legacy rows (pre-migration) have no body: reconstruct a
    // baseline once, then apply the directive — self-heals the row on the persist below.
    const baseBody = state.draftBody ?? (await generateDraft(idea, profile, moment, platform)).body;
    const { body, wasRedacted } = await refineDraft(baseBody, kind, idea, profile, moment, platform);

    await editCanvas(state.canvasId, canvasDocument(idea.hook, body));
    await scaClient().from("sca_thread_map").update({ draft_body: body }).eq("id", state.rowId);

    const caveat = wasRedacted ? REDACTED_NOTE : "";
    const done = `↻ ${REFINE_LABEL[kind]} — updated your ${PLATFORM_LABEL[platform]} canvas above.${caveat}`;
    if (interim?.ts) {
      await slack.chat.update({ channel, ts: interim.ts, text: done }).catch(() => {});
    } else {
      await safePost(channel, rootTs, done);
    }
  } catch (e) {
    await safePost(channel, rootTs, "Something went wrong — try again in a sec.");
    console.error("handleRefine failed", { slackUserId, ideaId: parsed.ideaId, platform, error: e });
  }
}
```

- [ ] **Step 5: Verify build and suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean; full suite PASS (no new unit tests — `handleRefine` is live-verified in Task 6, like its sibling handlers).

- [ ] **Step 6: Self-check the never-throw invariant (code review, no command)**

Confirm by reading: every `await` inside `handleRefine` is either inside the outer `try`, or (`slack.chat.postMessage`/`update`) carries its own `.catch`. The outer `catch` posts an honest message and logs. `parsed` is in scope inside `catch` (declared before `try`). No path re-throws.

- [ ] **Step 7: Commit**

```bash
git add lib/draft.ts
git commit -m "feat(sca): handleRefine — in-thread iteration loop (step 7)

Maps a refine:<kind> click to its (rep, idea, platform) draft, regenerates
building on the stored draft_body (legacy null-body self-heals via a one-off
baseline), edits the canvas in place, persists the new body, and confirms in
the idea thread. readMoment helper DRYs the moment read. Never throws post-ack.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Route the refine action

Dispatch `refine:*` clicks to `handleRefine` inside `waitUntil`, alongside the existing actions.

**Files:**
- Modify: `app/api/slack/interactivity/route.ts`

**Interfaces:**
- Consumes: `handleRefine` (Task 4), `REFINE_ACTION` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Extend the imports**

```ts
import { handleDraftThis, handleDraftPlatform, handleDraftRetry, handleDraftReplaceConfirm, handleDraftReplaceCancel, handleRefine } from "@/lib/draft";
import { DRAFT_THIS_ACTION, DRAFT_PLATFORM_ACTION, DRAFT_RETRY_ACTION, DRAFT_REPLACE_CONFIRM_ACTION, DRAFT_REPLACE_CANCEL_ACTION, REFINE_ACTION } from "@/lib/digest";
```

- [ ] **Step 2: Add the dispatch branch**

In the `if (payload.type === "block_actions")` chain, add a branch (place it after the `DRAFT_RETRY_ACTION` branch). `REFINE_ACTION` is `"refine"`; no other action_id starts with it, so `startsWith` is safe:

```ts
    } else if (actionId.startsWith(REFINE_ACTION)) {
      waitUntil(handleRefine(payload));
```

- [ ] **Step 3: Verify build and suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean; full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/slack/interactivity/route.ts
git commit -m "feat(sca): route refine:* clicks to handleRefine (step 7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Live verification (Trent hand-off)

No code. Deploy per the deploy model (`vercel --prod` **and** `git push origin main`), then verify on prod. This is the real proof — `handleRefine` has no unit harness by design.

- [ ] **Step 1: Deploy**

`vercel --prod`, then `git push origin main` (keep the remote synced — see memory `sca-deployment-model`).

- [ ] **Step 2: Fire a digest and draft an idea**

Confirm the opener now shows four buttons — **Shorter · Punchier · Less salesy · Different angle** — under the draft, in the idea's thread.

- [ ] **Step 3: Single refine edits in place**

Click **Shorter**. Expected: an `↻ Reworking…` note appears in the thread, then updates to `↻ Shorter — updated your … canvas above.`; the **same** canvas (no new canvas, no stub) now holds a shorter draft; the `# hook` heading is unchanged.

- [ ] **Step 4: Refinements compound**

Then click **Punchier**. Expected: the draft is now both shorter **and** punchier (proves it built on the stored body, not a fresh regen).

- [ ] **Step 5: Anonymization holds**

On a demo-sourced idea, click through all four buttons; confirm no real name/company leaks into any revision.

- [ ] **Step 6: Both-rep independence**

For a both-channel rep, draft both platforms, then refine the LinkedIn draft. Expected: the Instagram draft/canvas is untouched, and vice-versa. Threading stays clean (all refine messages nest under the idea; main feed unchanged).

- [ ] **Step 7: Record the outcome in `.superpowers/sdd/progress.md`** (feature complete + live-verified, per the project's convention).

---

## Notes & Deferred

- **`/api/slack/events` stays the spike echo.** Free-form thread replies are out of scope; the echo bot still replies to stray messages. Follow-up (not this plan): quiet or repurpose it.
- **Accepted edge — overlapping refine.** `draft_body` read-modify-write is last-write-wins; two refines within one generate window can drop one edit. Benign for a single rep; not serialized (same posture as the accepted single-canvas race).
- **Instagram refine** operates on the assembled body (caption + "Visual idea" section); `assembleCanvasBody` re-splits the fresh `===VISUAL===` output cleanly. v1 simplification — no separate caption store.
- **Step 8 (weekly cron)** remains the last owed Phase-1 item after this.

---

## Self-Review

- **Spec coverage:** Data model → Task 1. `refineDraft` + guardrail reuse → Task 2. Opener buttons + action contract → Task 3. `handleRefine` (mapping, self-heal, edit-in-place, persist, confirm, never-throw) → Task 4. Route dispatch → Task 5. Live proof → Task 6. Out-of-scope items → Notes. All spec sections mapped.
- **Placeholder scan:** none — every code step shows full code; every command shows expected output.
- **Type consistency:** `RefineKind`/`REFINE_KINDS`/`REFINE_LABEL` defined in generation.ts (Task 2), consumed by digest.ts (Task 3) and draft.ts (Task 4). `buildOpenerBlocks(ideaId, platform, opts)` new signature (Task 3) matches its only caller update (Task 3 Step 4). `handleRefine`/`REFINE_ACTION` produced in Tasks 3–4 match the route imports in Task 5. `draftStateForIdeaPlatform` return shape (`rowId`/`canvasId`/`draftBody`) matches its use in `handleRefine`.
