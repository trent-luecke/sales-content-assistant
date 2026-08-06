# Multi-Platform Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Draft this" loop platform-aware — draft in the shape of the platform(s) a rep uses, ask which platform only when the rep has both, and give Instagram drafts a text visual-concept section.

**Architecture:** A `platform` argument threads through `buildDraftPrompt`/`generateDraft` to swap the format instruction (and, for Instagram, assemble a `===VISUAL===` canvas section). `lib/draft.ts` is refactored onto a shared `claimAndDraft(idea, profile, platforms[])` spine: single-channel reps draft immediately; both-channel reps get a `draft_platform` button interstitial that claims on the pick and fans out to one canvas + one thread + one `sca_thread_map` row per platform. A nullable `sca_thread_map.platform` column persists the choice so the future step-7 iteration loop inherits it.

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, `@slack/web-api`, AI SDK (`ai` `generateText` + `@ai-sdk/anthropic`, model `claude-sonnet-5`), Supabase (`sca_*` project), Vitest.

## Global Constraints

- **Spec:** [2026-08-05-multiplatform-drafting-design.md](../specs/2026-08-05-multiplatform-drafting-design.md). Every task's requirements include this section.
- **Platform values are lowercase** — `"linkedin"` and `"instagram"` everywhere (DB check constraint, button value tokens, function args). Button *labels* shown to reps are `Instagram` / `LinkedIn` / `Both`.
- **Anonymization guardrail is unchanged and platform-independent.** `forbiddenNames → containsAny → regenerate once → redact` runs over the whole raw model output *before* any `===VISUAL===` split, so visual-concept text is anonymized too. Never weaken it.
- **Zero hashtags and zero emoji in the draft body on BOTH platforms.** This replaces today's "no hashtags unless the rep's examples use them" LinkedIn rule.
- **Post-ack invariant:** `handleDraftThis`, `handleDraftPlatform`, and `claimAndDraft` all run inside `waitUntil` and MUST NEVER throw. On total failure, release the claim (`setIdeaStatus(ideaId, "candidate")`).
- **Sentinel:** the literal string `===VISUAL===` on its own line separates the Instagram caption from the visual concepts in raw model output.
- **Instagram canvas label:** the visual section is introduced by the exact plain-text line `Visual idea — not part of your caption`.
- **Choice-message copy (exact):** `Which platform(s) will this be posted on?`
- **Monorepo hygiene:** repo root is `/Users/trentluecke/dev/Claude-Projects/sales-content-assistant` inside the `Claude-Projects` monorepo — **never `git add -A`**. Stage only files under this subdir and confirm with `git diff --cached --name-only`. Commit directly to `main`.
- **Test command:** `npm test` (`vitest run`). **Typecheck:** `npx tsc --noEmit`. Both must be green before each commit. Secret-using I/O (Slack/RAG/AI) is verified on a live Vercel deploy, not locally.

---

## File Structure

- `db/schema.sql` — add the `platform` column to the `sca_thread_map` create statement (source-of-truth mirror; the live migration is applied by hand in the SCA Supabase SQL editor).
- `lib/generation.ts` — add `Platform` type; add `platform` param to `buildDraftPrompt` + `generateDraft`; add pure helpers `splitVisual` and `assembleCanvasBody`.
- `lib/digest.ts` — add `DRAFT_PLATFORM_ACTION`, `buildPlatformChoiceBlocks`, and the `encodePlatformValue`/`parsePlatformValue` + `platformsForSelection` pure helpers.
- `lib/draft.ts` — refactor to the `claimAndDraft` spine; add `handleDraftPlatform`; branch `handleDraftThis` on `profile.channels`; the "Both" fan-out + partial-failure handling.
- `app/api/slack/interactivity/route.ts` — dispatch the new `draft_platform` action.
- Test files: `lib/__tests__/generation.test.ts` (extend), `lib/__tests__/digest.test.ts` (create or extend).

---

## Task 1: Schema — `sca_thread_map.platform` column

**Files:**
- Modify: `db/schema.sql:35-44`

**Interfaces:**
- Produces: the `platform text check (platform in ('linkedin','instagram'))` column that Task 5 writes and step 7 later reads.

No unit test (DDL mirror file). The live migration is a human step run in the SCA Supabase SQL editor; this task keeps the checked-in schema truthful.

- [ ] **Step 1: Edit the `sca_thread_map` create statement**

In `db/schema.sql`, change the `sca_thread_map` table to add the column (after `canvas_id`):

```sql
create table sca_thread_map (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references sca_profiles(id) on delete cascade,
  slack_channel text not null,
  thread_ts text not null,
  canvas_id text,
  platform text check (platform in ('linkedin','instagram')),
  idea_id uuid references sca_ideas(id) on delete set null,
  created_at timestamptz default now(),
  unique (slack_channel, thread_ts)
);
```

- [ ] **Step 2: Record the live-migration statement in the commit body**

The statement to run by hand against the live SCA Supabase project (no code executes it):

```sql
alter table sca_thread_map add column platform text
  check (platform in ('linkedin','instagram'));
```

- [ ] **Step 3: Commit**

```bash
git add db/schema.sql
git commit -m "feat(sca): add sca_thread_map.platform column to schema

Nullable, checked to ('linkedin','instagram'). Live migration (run by
hand in the SCA Supabase SQL editor):
  alter table sca_thread_map add column platform text
    check (platform in ('linkedin','instagram'));

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Generation — `Platform` type + per-platform prompt

**Files:**
- Modify: `lib/generation.ts:113-142` (`buildDraftPrompt`)
- Test: `lib/__tests__/generation.test.ts` (extend the existing `describe("buildDraftPrompt")`)

**Interfaces:**
- Produces: `export type Platform = "linkedin" | "instagram";` and the new signature `buildDraftPrompt(idea: Idea, profile: Profile, moment: DemoMoment | null, platform: Platform): string`.
- Consumes: existing `Idea`, `Profile`, `DemoMoment`, `renderTraits` (unchanged).

- [ ] **Step 1: Write the failing tests**

Add inside `describe("buildDraftPrompt")` in `lib/__tests__/generation.test.ts`. Note the existing tests in that block call `buildDraftPrompt` with 3 args — update those existing calls to pass `"linkedin"` as the 4th arg (e.g. `buildDraftPrompt(idea(), profile(), moment(), "linkedin")`) so the file compiles.

```typescript
it("LinkedIn: forbids hashtags and emoji, gives the LinkedIn length/shape, no visual instruction", () => {
  const p = buildDraftPrompt(idea(), profile(), moment(), "linkedin");
  expect(p.toLowerCase()).toContain("no hashtags");
  expect(p.toLowerCase()).toContain("no emoji");
  expect(p).toMatch(/120|250/); // the LinkedIn word-count guidance
  expect(p).not.toContain("===VISUAL===");
});

it("Instagram: forbids hashtags and emoji, gives the tight shape and the visual instruction", () => {
  const p = buildDraftPrompt(idea(), profile(), moment(), "instagram");
  expect(p.toLowerCase()).toContain("no hashtags");
  expect(p.toLowerCase()).toContain("no emoji");
  expect(p).toMatch(/first line/i);
  expect(p).toContain("===VISUAL===");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- generation`
Expected: FAIL — `buildDraftPrompt` still takes 3 args / assertions unmet.

- [ ] **Step 3: Implement the `platform` param**

In `lib/generation.ts`, add the type near the top (after imports):

```typescript
export type Platform = "linkedin" | "instagram";
```

Replace the first two `parts.push(...)` calls in `buildDraftPrompt` and add the platform block. The new signature and the leading push:

```typescript
export function buildDraftPrompt(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
  platform: Platform,
): string {
  const parts: string[] = [];
  parts.push(
    "Write a single social post in this sales rep's own voice. First person, natural. " +
      "No hashtags. No emoji. The rep will add those by hand if they want. Return ONLY the post text.",
  );
  parts.push(
    "HARD RULE: never name a customer, prospect, company, club, or deal. Render every " +
      "story as an anonymized pattern (e.g. 'a strength coach I spoke with'). If you are " +
      "unsure whether something identifies a real party, generalize it.",
  );
  if (platform === "linkedin") {
    parts.push(
      "## Platform: LinkedIn\nAim for ~120-250 words. Open with a strong first line, then an " +
        "anonymized insight, then a takeaway.",
    );
  } else {
    parts.push(
      "## Platform: Instagram\nKeep it tight (~40-110 words). Put the payload in the FIRST line " +
        "(Instagram truncates ~125 characters). Hook, one or two beats, a light close. Leave " +
        "whitespace between short lines.\n\nAfter the caption, output a line containing exactly " +
        "===VISUAL=== on its own, then 1-2 concrete, anonymized ideas for a visual asset the rep " +
        "could take to an image generator. Never name a real person, company, or client in the " +
        "visual ideas either.",
    );
  }
  // ... existing voice/background/angle/admired_post/what-to-say/moment pushes unchanged ...
```

Leave every `parts.push` below (voice traits, background, angle, admired_post, "What to say", moment) exactly as-is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- generation`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean). (Callers of `buildDraftPrompt`/`generateDraft` that don't yet pass `platform` will error — those are fixed in Tasks 3 and 5; if `generateDraft` in this file calls `buildDraftPrompt`, fix that call as part of Task 3. If tsc errors only in `generateDraft`, proceed — Task 3 resolves it and re-runs tsc.)

- [ ] **Step 6: Commit**

```bash
git add lib/generation.ts lib/__tests__/generation.test.ts
git commit -m "feat(sca): platform-aware draft prompt (LinkedIn vs Instagram, no hashtags/emoji)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Generation — `splitVisual`, `assembleCanvasBody`, and `platform` through `generateDraft`

**Files:**
- Modify: `lib/generation.ts` (add two pure helpers; add `platform` to `generateDraft`)
- Test: `lib/__tests__/generation.test.ts` (add a `describe` for the helpers; update existing `generateDraft` tests)

**Interfaces:**
- Produces:
  - `export function splitVisual(raw: string): { caption: string; visual: string | null }`
  - `export function assembleCanvasBody(raw: string, platform: Platform): string`
  - new signature `generateDraft(idea: Idea, profile: Profile, moment: DemoMoment | null, platform: Platform): Promise<{ body: string; wasRedacted: boolean }>`
- Consumes: `buildDraftPrompt(..., platform)` from Task 2; existing `containsAny`, `forbiddenNames`, `redact`.

**Design note:** the guardrail runs over the RAW model output (caption + visual) first; only then does `assembleCanvasBody` split and format. So `generateDraft` redacts `text` (raw) as today, then calls `assembleCanvasBody(text, platform)` to produce the canvas-ready `body`.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Add a new block to `lib/__tests__/generation.test.ts` (import `splitVisual` and `assembleCanvasBody` in the top import):

```typescript
describe("splitVisual", () => {
  it("splits caption from visual on the sentinel and trims", () => {
    const out = splitVisual("Caption line here\n===VISUAL===\nA close-up of a barbell");
    expect(out.caption).toBe("Caption line here");
    expect(out.visual).toBe("A close-up of a barbell");
  });
  it("returns null visual when the sentinel is absent", () => {
    const out = splitVisual("Just a caption, no sentinel");
    expect(out.caption).toBe("Just a caption, no sentinel");
    expect(out.visual).toBeNull();
  });
  it("uses only the first sentinel if the model emits more than one", () => {
    const out = splitVisual("cap\n===VISUAL===\nidea one\n===VISUAL===\nidea two");
    expect(out.caption).toBe("cap");
    expect(out.visual).toBe("idea one\n===VISUAL===\nidea two");
  });
});

describe("assembleCanvasBody", () => {
  it("LinkedIn returns the raw text unchanged", () => {
    expect(assembleCanvasBody("A LinkedIn post", "linkedin")).toBe("A LinkedIn post");
  });
  it("Instagram with a visual appends the labeled section", () => {
    const body = assembleCanvasBody("Caption\n===VISUAL===\nA barbell close-up", "instagram");
    expect(body).toContain("Caption");
    expect(body).toContain("Visual idea — not part of your caption");
    expect(body).toContain("A barbell close-up");
    expect(body).not.toContain("===VISUAL===");
  });
  it("Instagram without a sentinel returns caption only, no visual label", () => {
    const body = assembleCanvasBody("Just a caption", "instagram");
    expect(body).toBe("Just a caption");
    expect(body).not.toContain("Visual idea");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- generation`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the two pure helpers**

Add to `lib/generation.ts` (above `generateDraft`):

```typescript
const VISUAL_SENTINEL = "===VISUAL===";

// Split raw Instagram model output into caption + visual on the FIRST sentinel.
// No sentinel -> the whole text is the caption and visual is null.
export function splitVisual(raw: string): { caption: string; visual: string | null } {
  const i = raw.indexOf(VISUAL_SENTINEL);
  if (i === -1) return { caption: raw.trim(), visual: null };
  const caption = raw.slice(0, i).trim();
  const visual = raw.slice(i + VISUAL_SENTINEL.length).trim();
  return { caption, visual: visual.length > 0 ? visual : null };
}

// Turn raw (already-anonymized) model output into canvas-ready markdown.
// LinkedIn: unchanged. Instagram: caption + a labeled visual section when present.
export function assembleCanvasBody(raw: string, platform: Platform): string {
  if (platform === "linkedin") return raw;
  const { caption, visual } = splitVisual(raw);
  if (!visual) return caption;
  return `${caption}\n\n---\n\n**Visual idea — not part of your caption**\n\n${visual}`;
}
```

- [ ] **Step 4: Thread `platform` through `generateDraft`**

Change the `generateDraft` signature and its two `buildDraftPrompt` calls, and wrap the final text in `assembleCanvasBody`. The guardrail block in the middle is unchanged — it still operates on `text` (raw). Only the signature, the `buildDraftPrompt` calls, and the return line change:

```typescript
export async function generateDraft(
  idea: Idea,
  profile: Profile,
  moment: DemoMoment | null,
  platform: Platform,
): Promise<{ body: string; wasRedacted: boolean }> {
  const forbidden = moment ? forbiddenNames(moment) : [];
  const basePrompt = buildDraftPrompt(idea, profile, moment, platform);

  // ... unchanged: generateText, containsAny, regenerate-once, redact on `text` ...

  return { body: assembleCanvasBody(text, platform), wasRedacted };
}
```

(The retry prompt is `basePrompt + "..."` as today — no change beyond `basePrompt` now being platform-aware.)

- [ ] **Step 5: Update the existing `generateDraft` tests**

The existing `describe("generateDraft")` tests call `generateDraft(idea(), profile(), moment())` — add `"linkedin"` as the 4th arg to each. Their assertions still hold because `assembleCanvasBody(text, "linkedin")` returns `text` unchanged. Then add one Instagram assembly test:

```typescript
it("Instagram: anonymizes then assembles the visual section", async () => {
  vi.mocked(generateText).mockResolvedValueOnce({
    text: "a coach I met crushed it\n===VISUAL===\nphoto of an empty gym floor",
  } as any);
  const res = await generateDraft(idea(), profile(), moment(), "instagram");
  expect(res.wasRedacted).toBe(false);
  expect(res.body).toContain("a coach I met crushed it");
  expect(res.body).toContain("Visual idea — not part of your caption");
  expect(res.body).toContain("photo of an empty gym floor");
  expect(res.body).not.toContain("===VISUAL===");
});

it("Instagram: guardrail redacts a leaked name in the VISUAL block too", async () => {
  vi.mocked(generateText)
    .mockResolvedValueOnce({ text: "a coach crushed it\n===VISUAL===\nphoto of Chris lifting" } as any)
    .mockResolvedValueOnce({ text: "a coach crushed it\n===VISUAL===\nphoto of Chris lifting" } as any);
  const res = await generateDraft(idea(), profile(), moment(), "instagram");
  expect(res.wasRedacted).toBe(true);
  expect(res.body).not.toMatch(/Chris/);
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -- generation`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean, except any remaining error in `lib/draft.ts` calling `generateDraft` with 3 args — fixed in Task 5. If tsc reports only `lib/draft.ts` errors, proceed.

- [ ] **Step 7: Commit**

```bash
git add lib/generation.ts lib/__tests__/generation.test.ts
git commit -m "feat(sca): assemble Instagram visual-idea canvas section; guardrail-first split

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Digest — platform-choice action, blocks, and value helpers

**Files:**
- Modify: `lib/digest.ts` (add exports; `buildDigestBlocks` unchanged)
- Test: `lib/__tests__/digest.test.ts` (create if absent, else extend)

**Interfaces:**
- Produces:
  - `export const DRAFT_PLATFORM_ACTION = "draft_platform";`
  - `export type PlatformSelection = "linkedin" | "instagram" | "both";`
  - `export function encodePlatformValue(ideaId: string, selection: PlatformSelection): string` → `"<ideaId>|<selection>"`
  - `export function parsePlatformValue(value: string): { ideaId: string; selection: PlatformSelection } | null`
  - `export function platformsForSelection(selection: PlatformSelection): Platform[]`
  - `export function buildPlatformChoiceBlocks(ideaId: string): KnownBlock[]`
- Consumes: `Platform` from `lib/generation.ts`; `KnownBlock` from `@slack/web-api`.

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/digest.test.ts` (or add these blocks if it exists):

```typescript
import { describe, it, expect } from "vitest";
import {
  DRAFT_PLATFORM_ACTION,
  encodePlatformValue,
  parsePlatformValue,
  platformsForSelection,
  buildPlatformChoiceBlocks,
} from "@/lib/digest";

describe("platform value encoding", () => {
  it("round-trips ideaId and selection", () => {
    const v = encodePlatformValue("idea-123", "both");
    expect(v).toBe("idea-123|both");
    expect(parsePlatformValue(v)).toEqual({ ideaId: "idea-123", selection: "both" });
  });
  it("rejects malformed or unknown-selection values", () => {
    expect(parsePlatformValue("no-pipe")).toBeNull();
    expect(parsePlatformValue("idea-1|twitter")).toBeNull();
    expect(parsePlatformValue("|both")).toBeNull();
  });
});

describe("platformsForSelection", () => {
  it("maps each selection to platform list", () => {
    expect(platformsForSelection("linkedin")).toEqual(["linkedin"]);
    expect(platformsForSelection("instagram")).toEqual(["instagram"]);
    expect(platformsForSelection("both")).toEqual(["linkedin", "instagram"]);
  });
});

describe("buildPlatformChoiceBlocks", () => {
  it("asks the platform question with three correctly-encoded buttons", () => {
    const blocks = buildPlatformChoiceBlocks("idea-9");
    const json = JSON.stringify(blocks);
    expect(json).toContain("Which platform(s) will this be posted on?");
    expect(json).toContain(DRAFT_PLATFORM_ACTION);
    expect(json).toContain("idea-9|instagram");
    expect(json).toContain("idea-9|linkedin");
    expect(json).toContain("idea-9|both");
    // Button labels
    expect(json).toContain("Instagram");
    expect(json).toContain("LinkedIn");
    expect(json).toContain("Both");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- digest`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `lib/digest.ts`**

Add the import and exports (place near `DRAFT_THIS_ACTION`):

```typescript
import type { Platform } from "@/lib/generation";

export const DRAFT_PLATFORM_ACTION = "draft_platform";
export type PlatformSelection = "linkedin" | "instagram" | "both";

export function encodePlatformValue(ideaId: string, selection: PlatformSelection): string {
  return `${ideaId}|${selection}`;
}

export function parsePlatformValue(
  value: string,
): { ideaId: string; selection: PlatformSelection } | null {
  const i = value.indexOf("|");
  if (i <= 0) return null; // no pipe, or empty ideaId
  const ideaId = value.slice(0, i);
  const sel = value.slice(i + 1);
  if (sel !== "linkedin" && sel !== "instagram" && sel !== "both") return null;
  return { ideaId, selection: sel };
}

export function platformsForSelection(selection: PlatformSelection): Platform[] {
  return selection === "both" ? ["linkedin", "instagram"] : [selection];
}

export function buildPlatformChoiceBlocks(ideaId: string): KnownBlock[] {
  const button = (text: string, selection: PlatformSelection) => ({
    type: "button" as const,
    text: { type: "plain_text" as const, text },
    action_id: DRAFT_PLATFORM_ACTION,
    value: encodePlatformValue(ideaId, selection),
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Which platform(s) will this be posted on?" },
    },
    {
      type: "actions",
      elements: [
        button("Instagram", "instagram"),
        button("LinkedIn", "linkedin"),
        button("Both", "both"),
      ],
    },
  ];
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- digest`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean (except pending `lib/draft.ts` from Task 5).

- [ ] **Step 5: Commit**

```bash
git add lib/digest.ts lib/__tests__/digest.test.ts
git commit -m "feat(sca): platform-choice Block Kit + value encode/parse helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Draft orchestration — `claimAndDraft` spine, channel branch, Both fan-out

**Files:**
- Modify: `lib/draft.ts` (refactor `handleDraftThis`; add `claimAndDraft` and `handleDraftPlatform`)

**Interfaces:**
- Produces: `export async function handleDraftPlatform(payload: unknown): Promise<void>` and the refactored `handleDraftThis`.
- Consumes: `generateDraft(idea, profile, moment, platform)` (Task 3); `parsePlatformValue`, `platformsForSelection`, `buildPlatformChoiceBlocks` (Task 4); existing `claimIdea`, `setIdeaStatus`, `readDemoMoment`, `createCanvasInDM`, `getProfileBySlackUser`, `slack`, `scaClient`, `Platform`.

**Design note (no unit test):** `lib/draft.ts` is pure Slack/RAG/AI I/O and follows the repo's "verified on a live deploy, not unit-tested" convention — matching how the step-6 `handleDraftThis` shipped. This task is a structural refactor + additions; correctness is confirmed by `tsc` here and the Task 7 live pass. Keep every function non-throwing (post-ack invariant).

- [ ] **Step 1: Add helpers — platform label + normalized channels**

At the top of `lib/draft.ts` (after imports), add:

```typescript
import type { Platform } from "@/lib/generation";
import { parsePlatformValue, platformsForSelection, buildPlatformChoiceBlocks } from "@/lib/digest";

const PLATFORM_LABEL: Record<Platform, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
};

// The rep's configured platforms, normalized to our lowercase Platform values.
// Empty/unknown -> default to LinkedIn so a rep is never stuck.
function repPlatforms(profile: { channels: unknown[] }): Platform[] {
  const out: Platform[] = [];
  for (const c of profile.channels ?? []) {
    const l = String(c).toLowerCase();
    if (l === "linkedin" && !out.includes("linkedin")) out.push("linkedin");
    if (l === "instagram" && !out.includes("instagram")) out.push("instagram");
  }
  return out.length > 0 ? out : ["linkedin"];
}
```

- [ ] **Step 2: Extract the shared `claimAndDraft` spine**

Add this function. It generalizes the current `handleDraftThis` body to N platforms with a single claim, one shared moment read, concurrent per-platform generation, and the total/partial failure rules:

```typescript
// Claim the idea once, then draft one canvas + thread + sca_thread_map row per
// platform. Runs post-ack; never throws. Total failure releases the claim;
// partial success (Both) keeps it and reports the gap.
async function claimAndDraft(
  ideaId: string,
  profile: Awaited<ReturnType<typeof getProfileBySlackUser>> & object,
  channel: string,
  platforms: Platform[],
): Promise<void> {
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

  const label = platforms.map((p) => PLATFORM_LABEL[p]).join(" & ");
  const interim = await slack.chat
    .postMessage({ channel, text: `✍️ Drafting your ${label} draft${platforms.length > 1 ? "s" : ""}…` })
    .catch(() => null);
  const interimTs = interim?.ts;

  // One shared moment read for all platforms.
  const meetingId =
    typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
      ? (idea.source_ref as { meetingId: string }).meetingId
      : null;
  const moment =
    idea.source === "demo" && meetingId
      ? await readDemoMoment(meetingId).catch(() => null)
      : null;

  // Draft each platform independently; the first reuses the interim message as
  // its opener/thread parent, the rest post fresh. Returns ok/fail per platform.
  const results = await Promise.all(
    platforms.map((platform, i) =>
      draftOnePlatform(idea, profile, channel, moment, platform, i === 0 ? interimTs : undefined),
    ),
  );

  const anyOk = results.some((r) => r.ok);
  const anyFail = results.some((r) => !r.ok);

  if (!anyOk) {
    // Total failure: release the claim; turn the interim into an error.
    await setIdeaStatus(ideaId, "candidate").catch(() => {});
    await updateOrPost(channel, interimTs, "Something went wrong drafting that — try again in a sec.");
    return;
  }
  if (anyFail) {
    // Partial (Both): keep the claim; name the platform that failed.
    const failed = results.filter((r) => !r.ok).map((r) => PLATFORM_LABEL[r.platform]).join(" & ");
    await safePost(channel, undefined, `I hit a snag on the ${failed} draft — click Draft this again to retry it.`);
  }
}
```

- [ ] **Step 3: Add `draftOnePlatform`**

One platform = one canvas + one opener + one map row. Returns a result rather than throwing, so `Promise.all` never rejects and the post-ack invariant holds:

```typescript
async function draftOnePlatform(
  idea: import("@/lib/ideas").Idea,
  profile: { id: string },
  channel: string,
  moment: import("@/lib/generation").DemoMoment | null,
  platform: Platform,
  reuseTs: string | undefined,
): Promise<{ ok: boolean; platform: Platform }> {
  try {
    const { body, wasRedacted } = await generateDraft(idea, profile as never, moment, platform);
    const canvasId = await createCanvasInDM(channel, draftTitle(idea.hook), body);

    const openerText = wasRedacted ? OPENER + REDACTED_NOTE : OPENER;
    let threadTs = reuseTs;
    if (reuseTs) {
      await slack.chat.update({ channel, ts: reuseTs, text: openerText });
    } else {
      const op = await slack.chat.postMessage({ channel, text: openerText });
      threadTs = op.ts;
    }
    if (!threadTs) throw new Error("no thread ts for draft session");

    const { error } = await scaClient().from("sca_thread_map").insert({
      rep_id: profile.id,
      slack_channel: channel,
      thread_ts: threadTs,
      canvas_id: canvasId,
      idea_id: idea.id,
      platform,
    });
    if (error) throw error;
    return { ok: true, platform };
  } catch (e) {
    console.error("draftOnePlatform failed", { repId: profile.id, ideaId: idea.id, platform, error: e });
    return { ok: false, platform };
  }
}
```

- [ ] **Step 4: Rewrite `handleDraftThis` to branch on channels**

Replace the body of `handleDraftThis` (keep the payload extraction + the outer pre-claim try/catch shape). Single/empty channel → draft now; both → post the choice message, no claim:

```typescript
export async function handleDraftThis(payload: unknown): Promise<void> {
  const p = payload as { actions?: { value?: unknown }[]; user?: { id?: unknown }; channel?: { id?: unknown } };
  const ideaId = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (typeof ideaId !== "string" || typeof slackUserId !== "string" || typeof channel !== "string") return;

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    const platforms = repPlatforms(profile);
    if (platforms.length > 1) {
      // Both channels: ask before committing (no claim yet).
      await slack.chat
        .postMessage({ channel, blocks: buildPlatformChoiceBlocks(ideaId), text: "Which platform(s) will this be posted on?" })
        .catch((e) => console.error("platform choice post failed", { ideaId, error: e }));
      return;
    }
    await claimAndDraft(ideaId, profile, channel, platforms);
  } catch (e) {
    await safePost(channel, undefined, "Something went wrong — try again in a sec.");
    console.error("handleDraftThis failed (pre-claim)", { slackUserId, ideaId, error: e });
  }
}
```

- [ ] **Step 5: Add `handleDraftPlatform`**

```typescript
export async function handleDraftPlatform(payload: unknown): Promise<void> {
  const p = payload as { actions?: { value?: unknown }[]; user?: { id?: unknown }; channel?: { id?: unknown } };
  const rawValue = p?.actions?.[0]?.value;
  const slackUserId = p?.user?.id;
  const channel = p?.channel?.id;
  if (typeof rawValue !== "string" || typeof slackUserId !== "string" || typeof channel !== "string") return;

  const parsed = parsePlatformValue(rawValue);
  if (!parsed) return;

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, undefined, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    await claimAndDraft(parsed.ideaId, profile, channel, platformsForSelection(parsed.selection));
  } catch (e) {
    await safePost(channel, undefined, "Something went wrong — try again in a sec.");
    console.error("handleDraftPlatform failed (pre-claim)", { slackUserId, ideaId: parsed.ideaId, error: e });
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Fix any signature mismatch (e.g. the `profile as never` cast is a pragmatic bridge because `generateDraft` wants the full `Profile`; if tsc complains, type `draftOnePlatform`'s `profile` param as `import("@/lib/profiles").Profile` and pass the real profile through from `claimAndDraft`).

- [ ] **Step 7: Run the full unit suite (nothing should regress)**

Run: `npm test`
Expected: all green (draft.ts has no unit tests; generation + digest suites pass).

- [ ] **Step 8: Commit**

```bash
git add lib/draft.ts
git commit -m "feat(sca): claimAndDraft spine — channel branch, platform pick, Both fan-out

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Route — dispatch `draft_platform`

**Files:**
- Modify: `app/api/slack/interactivity/route.ts`

**Interfaces:**
- Consumes: `handleDraftPlatform` (Task 5); `DRAFT_PLATFORM_ACTION` (Task 4); existing `handleDraftThis`, `DRAFT_THIS_ACTION`.

- [ ] **Step 1: Add the import and the dispatch branch**

Update the imports and the action dispatch. Replace the single-action `if` with a two-action dispatch:

```typescript
import { handleDraftThis } from "@/lib/draft";
import { handleDraftPlatform } from "@/lib/draft";
import { DRAFT_THIS_ACTION, DRAFT_PLATFORM_ACTION } from "@/lib/digest";
```

```typescript
  if (payload.type === "block_actions") {
    const actionId = payload.actions?.[0]?.action_id;
    if (actionId === DRAFT_THIS_ACTION) {
      waitUntil(handleDraftThis(payload));
    } else if (actionId === DRAFT_PLATFORM_ACTION) {
      waitUntil(handleDraftPlatform(payload));
    }
  }
  return new Response(null, { status: 200 });
```

- [ ] **Step 2: Typecheck + full test suite**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add app/api/slack/interactivity/route.ts
git commit -m "feat(sca): dispatch draft_platform interactivity action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Live verification on Vercel

**Files:** none (verification only).

**Prerequisite (human step):** run the live migration in the SCA Supabase SQL editor:
```sql
alter table sca_thread_map add column platform text
  check (platform in ('linkedin','instagram'));
```
Then push `main` and let Vercel deploy to `https://sales-content-assistant.vercel.app`.

- [ ] **Step 1: Confirm the deploy is live and green**

Confirm the latest commit deployed (Vercel dashboard / `vercel` CLI) with no build errors.

- [ ] **Step 2: Both-channel rep — the choice appears**

Ensure a test profile has `channels = ["LinkedIn","Instagram"]`. Fire a digest:
```bash
curl -s -X POST https://sales-content-assistant.vercel.app/api/digest/generate -H 'content-type: application/json' -d '{"slackUserId":"<your U-id>"}'
```
(Use the endpoint's real contract; the point is to deliver a fresh digest DM.) In Slack, click **Draft this** → expect the message **"Which platform(s) will this be posted on?"** with **Instagram / LinkedIn / Both** buttons. No canvas yet, no claim.

- [ ] **Step 3: LinkedIn only**

Click **LinkedIn** → one canvas, LinkedIn-shaped (~120-250 words), **no hashtags, no emoji, no "Visual idea" section**; opener threads; one `sca_thread_map` row with `platform = 'linkedin'`.

- [ ] **Step 4: Instagram only** (fresh idea)

Click **Draft this** on another idea → **Instagram** → one canvas, tight caption + a **"Visual idea — not part of your caption"** section; no hashtags/emoji in the caption; one row `platform = 'instagram'`.

- [ ] **Step 5: Both** (fresh idea)

Click **Draft this** → **Both** → **two** canvases (one LinkedIn-shaped, one Instagram-shaped with the visual section), two opener threads, and **two** `sca_thread_map` rows for the same `idea_id` with `platform` `'linkedin'` and `'instagram'`.

- [ ] **Step 6: Single-channel rep — no question**

With a profile whose `channels = ["LinkedIn"]`, click **Draft this** → drafts immediately (no platform question), row `platform = 'linkedin'`.

- [ ] **Step 7: Re-click guard**

Click **Draft this** (or a platform button) again on an already-drafted idea → gentle **"You're already drafting this one 👆"**, no duplicate canvas.

- [ ] **Step 8: Anonymization spot-check**

On real transcript data, confirm no customer/prospect/company names appear in either the caption or the Instagram visual-idea text.

- [ ] **Step 9: Verify the DB rows**

In the SCA Supabase SQL editor:
```sql
select idea_id, platform, thread_ts, canvas_id from sca_thread_map order by created_at desc limit 10;
```
Confirm platforms are populated correctly and "Both" produced two rows per `idea_id`.

---

## Self-Review

**Spec coverage:**
- Per-post choice for both-channel reps → Tasks 4 (blocks) + 5 (branch) + 6 (dispatch); live Step 2/6. ✅
- Two canvases/threads/rows for "Both" from one claim → Task 5 (`claimAndDraft` + `draftOnePlatform`); live Step 5/9. ✅
- Per-platform draft shaping + zero hashtags/emoji both platforms → Task 2; live Step 3/4. ✅
- Instagram visual-concept section (guardrail-first) → Tasks 2 (prompt) + 3 (split/assemble); live Step 4/8. ✅
- `sca_thread_map.platform` column, nullable, checked → Task 1; write in Task 5; live Step 9. ✅
- Total vs partial-failure handling → Task 5 Step 2. ✅
- Empty channels → default LinkedIn → Task 5 `repPlatforms`; live Step 6 (single-channel path). ✅
- Digest "Draft this" button unchanged → confirmed: Task 4 adds a *new* action, `buildDigestBlocks` untouched. ✅
- Deferred claim (both-channel claims on pick, not on `draft_this`) → Task 5 Step 4 (choice post, no claim) + Step 5 (`claimAndDraft` claims). ✅

**Placeholder scan:** no TBD/TODO; every code step shows full code; commands have expected output. ✅

**Type consistency:** `Platform` (`lib/generation.ts`) reused in `lib/digest.ts` and `lib/draft.ts`; `PlatformSelection` only in `lib/digest.ts`; `platformsForSelection` returns `Platform[]` consumed by `claimAndDraft(platforms: Platform[])`; `generateDraft(idea, profile, moment, platform)` 4-arg signature consistent across Tasks 2/3/5; `parsePlatformValue` shape `{ ideaId, selection }` consumed in Task 5 Step 5. ✅
