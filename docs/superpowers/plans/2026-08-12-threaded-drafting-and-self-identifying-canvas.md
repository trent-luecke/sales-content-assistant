# Threaded Drafting & Self-Identifying Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each reused canvas self-identify (stable platform title + the idea's hook as an H1 in the body) and nest all drafting under the idea that started it (per-idea digest messages + threaded replies).

**Architecture:** Part A retires the hook-bearing canvas title (Slack can't rename a canvas) in favor of a fixed `"<Platform> draft"` title plus a hook H1 prepended to the canvas document on every create/edit. Part B splits the weekly digest into a header + one message per idea and threads every draft-flow bot message under the clicked idea via `rootTs = message.thread_ts ?? message.ts`. No schema migration.

**Tech Stack:** Next.js (App Router, vendored), TypeScript, `@slack/web-api`, Supabase (`sca_thread_map`, `sca_digests`), Vitest for pure logic.

## Global Constraints

Copied verbatim from the spec — every task's requirements implicitly include these:

- **Post-ack invariant:** every interactivity handler runs inside `waitUntil` and must NEVER throw. Handlers own all failure handling.
- **No schema migration.** No columns added, no constraints changed. `sca_thread_map.thread_ts` continues to hold the opener reply's own ts (unique), so `unique(slack_channel, thread_ts)` is unaffected. Every draft still inserts one `sca_thread_map` row (utilization data survives).
- **No delete-based Slack calls** anywhere (`canvases.delete` / `files.delete` must never appear).
- **Slack cannot rename a canvas.** `canvases.edit` accepts only `canvas_id` + document-content `changes`. Identity comes from a **stable title** `"<Platform label> draft"` (e.g. `"LinkedIn draft"`) set at create, plus the idea's hook as an **H1 heading** at the top of the canvas document, refreshed on every full-document replace.
- **Thread root derivation (exact):** `rootTs = message.thread_ts ?? message.ts` (fall back through `container.thread_ts` / `container.message_ts`). If both are absent, `rootTs` is `undefined` and posts fall back to top-level (never throw).
- **Anonymization guardrail in `generateDraft` is unchanged.** Rep is the author; AI never publishes.
- **Testing split (repo convention):** pure logic in `lib/generation.ts` and `lib/digest.ts` is unit-tested with Vitest (`npm test`). Slack/DB I/O in `lib/draft.ts` and `assembleAndDeliver` is verified by `npx tsc --noEmit` + a live pass. `assembleAndDeliver` has existing mocked-Slack unit tests that must be kept green.
- **Typecheck gate:** `npx tsc --noEmit`. There is no `noUnusedLocals`, so dead imports/functions pass tsc silently — remove them by hand and confirm with grep.
- **Commit directly to `main`.** Stage only the specific files per task (`git add <paths>`, then confirm `git diff --cached --name-only`) — never `git add -A`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/generation.ts` | Pure text helpers for drafting/canvas | Add `canvasName`, `canvasDocument`; later remove `canvasTitle` + `PLATFORM_TAG` |
| `lib/__tests__/generation.test.ts` | Unit tests for generation helpers | Add `canvasName`/`canvasDocument` tests; later remove `canvasTitle` test |
| `lib/draft.ts` | Interactivity handlers + drafting (I/O) | Use `canvasName`/`canvasDocument`; later derive + thread `rootTs` through every draft-flow post |
| `lib/digest.ts` | Pure Block Kit builders + digest delivery | Update opener copy; replace `buildDigestBlocks` with `buildDigestHeaderBlocks` + `buildIdeaBlocks`; rewrite `assembleAndDeliver` to post header + one message per idea |
| `lib/__tests__/digest.test.ts` | Unit tests for builders + `assembleAndDeliver` | Update opener tests; replace digest-blocks tests; update `assembleAndDeliver` tests |

**Sequencing rationale (every commit stays `tsc`-green, no dead code):**
- **Task 1** adds `canvasName`/`canvasDocument` additively — nothing else changes.
- **Task 2** moves all `canvasTitle` callers to the new helpers, updates the opener copy, and retires `canvasTitle` + `PLATFORM_TAG` in the **same commit** — required, because `canvasTitle` has exactly three callers (two in `draft.ts`, one in `digest.ts`) and removing it before they move goes red.
- **Task 3** replaces the digest builders + delivery (digest.ts + its tests only).
- **Task 4** adds threading to `draft.ts` only. It depends on Task 2's slimmed `buildOpenerBlocks(platform, opts?)` signature.

---

## Task 1: Add `canvasName` + `canvasDocument` to `lib/generation.ts` (pure, TDD)

Purely additive. Two small pure helpers + their tests. `canvasTitle`/`PLATFORM_TAG` are untouched (still used by callers until Task 2).

**Files:**
- Modify: `lib/generation.ts` (add both helpers just after `canvasTitle`, ~line 123)
- Test: `lib/__tests__/generation.test.ts`

**Interfaces:**
- Consumes: `PLATFORM_LABEL` (already in `lib/generation.ts`), `Platform`.
- Produces (later tasks rely on these exact signatures):
  - `export function canvasName(platform: Platform): string` — `"LinkedIn draft"` / `"Instagram draft"`
  - `export function canvasDocument(hook: string, body: string): string` — `` `# ${hook}\n\n${body}` ``

- [ ] **Step 1: Write the failing tests**

Add `canvasName` and `canvasDocument` to the existing `@/lib/generation` import block in `lib/__tests__/generation.test.ts` (it already imports `canvasTitle`). Then append:

```ts
describe("canvasName", () => {
  it("is a stable, platform-level title with no hook", () => {
    expect(canvasName("linkedin")).toBe("LinkedIn draft");
    expect(canvasName("instagram")).toBe("Instagram draft");
  });
});

describe("canvasDocument", () => {
  it("prefixes the body with the hook as an H1 heading", () => {
    expect(canvasDocument("My great hook", "Body line one.")).toBe("# My great hook\n\nBody line one.");
  });
  it("preserves the body verbatim below the heading", () => {
    const body = "Para one.\n\n---\n\n**Visual idea**\n\nDo X.";
    expect(canvasDocument("Hook", body)).toBe(`# Hook\n\n${body}`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- generation`
Expected: FAIL — `canvasName` / `canvasDocument` are not exported (import error / not a function).

- [ ] **Step 3: Implement the helpers**

In `lib/generation.ts`, immediately after the `canvasTitle` function (~line 123), add:

```ts
// A stable, platform-level canvas title. There is one reused canvas per platform, so this
// never needs to change — and Slack has no API to rename a canvas. e.g. "LinkedIn draft".
export function canvasName(platform: Platform): string {
  return `${PLATFORM_LABEL[platform]} draft`;
}

// The canvas document: the idea's hook as an H1 heading above the drafted body. Passed to
// both create and the full-document reuse-edit, so the heading always names the current
// idea even though the canvas title itself is fixed.
export function canvasDocument(hook: string, body: string): string {
  return `# ${hook}\n\n${body}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- generation`
Expected: PASS (new tests green; existing generation tests still green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add lib/generation.ts lib/__tests__/generation.test.ts
git diff --cached --name-only
git commit -m "feat(sca): add canvasName + canvasDocument helpers"
```

---

## Task 2: Adopt the new canvas identity + retire `canvasTitle`/`PLATFORM_TAG` (atomic)

One atomic commit across five files. Move every `canvasTitle` caller to `canvasName` + `canvasDocument`, update the opener copy to drop the hook-bearing title, and remove the now-dead `canvasTitle` + `PLATFORM_TAG` (+ their test). Splitting this goes `tsc`-red.

**Files:**
- Modify: `lib/draft.ts` (`draftOnePlatform`: build the document once, use `canvasName`; import swap)
- Modify: `lib/digest.ts` (`buildOpenerBlocks`: new copy, drop `hook` param and `canvasTitle` import)
- Modify: `lib/generation.ts` (remove `canvasTitle` + `PLATFORM_TAG`)
- Modify: `lib/__tests__/generation.test.ts` (remove the `canvasTitle` describe + import)
- Modify: `lib/__tests__/digest.test.ts` (rewrite the `buildOpenerBlocks` describe)

**Interfaces:**
- Consumes: `canvasName`, `canvasDocument` (Task 1).
- Produces the slimmed opener signature every caller must match:
  - `export function buildOpenerBlocks(platform: Platform, opts?: { wasRedacted?: boolean }): KnownBlock[]`

- [ ] **Step 1: Rewrite the `buildOpenerBlocks` unit tests (failing first)**

In `lib/__tests__/digest.test.ts`, replace the entire `describe("buildOpenerBlocks", ...)` block (currently lines 262-282) with:

```ts
describe("buildOpenerBlocks", () => {
  it("names the platform's canvas, with no buttons", () => {
    const blocks = buildOpenerBlocks("linkedin");
    const json = JSON.stringify(blocks);
    expect(json).toContain("LinkedIn");
    expect(json).toContain("canvas");
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });
  it("uses the Instagram label for instagram", () => {
    expect(JSON.stringify(buildOpenerBlocks("instagram"))).toContain("Instagram");
  });
  it("appends the redaction caveat only when wasRedacted", () => {
    const withNote = JSON.stringify(buildOpenerBlocks("linkedin", { wasRedacted: true }));
    const without = JSON.stringify(buildOpenerBlocks("linkedin"));
    expect(withNote).toContain("redact");
    expect(without).not.toContain("redact");
  });
});
```

- [ ] **Step 2: Run the opener tests to verify they fail**

Run: `npm test -- digest`
Expected: FAIL — `buildOpenerBlocks("linkedin")` is called with the wrong arity (still requires `hook`) and the current copy contains `"LI: ..."`; the new no-hook calls / assertions fail.

- [ ] **Step 3: Slim `buildOpenerBlocks` in `lib/digest.ts`**

Replace the entire current `buildOpenerBlocks` (the function starting ~line 229, `export function buildOpenerBlocks(platform: Platform, hook: string, opts?: ...)`) with:

```ts
export function buildOpenerBlocks(
  platform: Platform,
  opts?: { wasRedacted?: boolean },
): KnownBlock[] {
  const caveat = opts?.wasRedacted ? REDACTED_NOTE : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Your *${PLATFORM_LABEL[platform]}* draft is in the canvas at the top of this chat. ` +
          `Reply in this thread to tell me what to change.${caveat}`,
      },
    },
  ];
}
```

- [ ] **Step 4: Drop the `canvasTitle` import from `lib/digest.ts`**

Change the generation import (line 8) from:

```ts
import { PLATFORM_LABEL, canvasTitle } from "@/lib/generation";
```

to:

```ts
import { PLATFORM_LABEL } from "@/lib/generation";
```

- [ ] **Step 5: Update `draftOnePlatform` in `lib/draft.ts`**

Change the generation import (line 6) from:

```ts
import { generateDraft, canvasTitle } from "@/lib/generation";
```

to:

```ts
import { generateDraft, canvasName, canvasDocument } from "@/lib/generation";
```

Then in `draftOnePlatform`, build the document once and use the stable title. Replace the block from `const { body, wasRedacted } = await generateDraft(...)` through the end of the canvas resolution (currently lines 197-217, ending at the `buildOpenerBlocks` line) with:

```ts
    const { body, wasRedacted } = await generateDraft(idea, profile, moment, platform);
    const document = canvasDocument(idea.hook, body);

    // Reuse the rep's existing canvas for this platform, editing it in place. If the
    // edit fails (canvas deleted out from under us) fall back to a fresh canvas so a
    // draft never dead-ends. If there's no existing canvas, create one.
    // Use the caller's resolved value when provided (undefined = not resolved → look it up).
    const existingCanvasId = knownCanvasId !== undefined ? knownCanvasId : await currentCanvasId(profile.id, platform);
    let canvasId: string;
    if (existingCanvasId) {
      try {
        await editCanvas(existingCanvasId, document);
        canvasId = existingCanvasId;
      } catch (e) {
        console.error("editCanvas failed; creating a fresh canvas", { repId: profile.id, platform, canvasId: existingCanvasId, error: e });
        canvasId = await createCanvasInDM(channel, canvasName(platform), document);
      }
    } else {
      canvasId = await createCanvasInDM(channel, canvasName(platform), document);
    }

    const openerBlocks = buildOpenerBlocks(platform, { wasRedacted });
```

(The rest of `draftOnePlatform` — the opener post/update, the `sca_thread_map` insert, the catch — is unchanged.)

- [ ] **Step 6: Remove `canvasTitle` + `PLATFORM_TAG` from `lib/generation.ts`**

Delete the `PLATFORM_TAG` constant (currently ~lines 113-116) and the entire `canvasTitle` function (currently ~lines 118-123, the comment + function). `PLATFORM_LABEL` stays. `canvasName`/`canvasDocument` (Task 1) stay.

- [ ] **Step 7: Remove the `canvasTitle` test from `lib/__tests__/generation.test.ts`**

Delete the entire `describe("canvasTitle", ...)` block (currently ~lines 201-208) and remove `canvasTitle` from the `@/lib/generation` import at the top of the file.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). A `Cannot find name 'canvasTitle'` / `'PLATFORM_TAG'` error means a caller was missed.

- [ ] **Step 9: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the rewritten `buildOpenerBlocks` and the new `canvasName`/`canvasDocument` tests; no test references `canvasTitle` or `PLATFORM_TAG`.

- [ ] **Step 10: Grep for surviving references (must be empty)**

Run:
```bash
grep -rn "canvasTitle\|PLATFORM_TAG" --include="*.ts" --include="*.tsx" . | grep -v node_modules
```
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add lib/draft.ts lib/digest.ts lib/generation.ts lib/__tests__/generation.test.ts lib/__tests__/digest.test.ts
git diff --cached --name-only
git commit -m "feat(sca): stable canvas title + hook-as-H1 body; retire canvasTitle/PLATFORM_TAG"
```

---

## Task 3: Split the weekly digest into a header + one message per idea

Replace the single combined `buildDigestBlocks` message with a header builder + a per-idea builder, and rewrite `assembleAndDeliver` to post one header message then one message per idea. Touches `lib/digest.ts` + its tests only.

**Files:**
- Modify: `lib/digest.ts` (replace `buildDigestBlocks`; rewrite `assembleAndDeliver`)
- Modify: `lib/__tests__/digest.test.ts` (replace the digest-blocks tests; update the `assembleAndDeliver` tests)

**Interfaces:**
- Consumes: `DRAFT_THIS_ACTION`, `selectTopCandidates`, `slack`, `scaClient` (all already in `lib/digest.ts`).
- Produces:
  - `export function buildDigestHeaderBlocks(): KnownBlock[]`
  - `export function buildIdeaBlocks(idea: Idea): KnownBlock[]` (throws if `idea.id` is missing)
  - `assembleAndDeliver(profile)` unchanged return shape `{ ideaCount, messageTs, recorded }`; `messageTs` is now the **header** message ts.

- [ ] **Step 1: Rewrite the digest-blocks tests (failing first)**

In `lib/__tests__/digest.test.ts`: in the `@/lib/digest` import block, remove `buildDigestBlocks` and add `buildDigestHeaderBlocks, buildIdeaBlocks`. Then replace the entire `describe("buildDigestBlocks", ...)` block (currently lines 55-101) with:

```ts
describe("buildDigestHeaderBlocks", () => {
  it("returns a single framing section, no buttons", () => {
    const blocks = buildDigestHeaderBlocks();
    expect(types(blocks)).toEqual(["section"]);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("worth saying this week");
  });
});

describe("buildIdeaBlocks", () => {
  it("renders one idea as a section + a single Draft this button carrying the idea id", () => {
    const blocks = buildIdeaBlocks(mk("id-1", "Go quiet in the demo"));
    expect(types(blocks)).toEqual(["section", "actions"]);
    const body = blocks[0] as any;
    expect(body.text.type).toBe("mrkdwn");
    expect(body.text.text).toContain("Go quiet in the demo");
    expect(body.text.text).toContain("why Go quiet in the demo lands");
    const btns = buttons(blocks);
    expect(btns).toHaveLength(1);
    expect(btns[0].action_id).toBe(DRAFT_THIS_ACTION);
    expect(btns[0].value).toBe("id-1");
    expect(DRAFT_THIS_ACTION).toBe("draft_this");
  });

  it("throws when an idea is missing its id", () => {
    const noId = { ...mk("x", "hook"), id: undefined } as Idea;
    expect(() => buildIdeaBlocks(noId)).toThrow(/missing an id/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- digest`
Expected: FAIL — `buildDigestHeaderBlocks` / `buildIdeaBlocks` are not exported.

- [ ] **Step 3: Replace `buildDigestBlocks` in `lib/digest.ts`**

Delete the entire `buildDigestBlocks` function (currently ~lines 104-138, the comment + function) and add in its place:

```ts
// Pure: the digest's lead-in message — one framing section, no buttons.
export function buildDigestHeaderBlocks(): KnownBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Here are a few things worth saying this week." },
    },
  ];
}

// Pure: one idea as its own message — a section (bold hook + rationale) and an actions
// block with a single "Draft this" button carrying the idea id. This message's ts becomes
// the idea's thread root, so drafting nests under it.
export function buildIdeaBlocks(idea: Idea): KnownBlock[] {
  if (!idea.id) {
    throw new Error("buildIdeaBlocks: idea is missing an id (cannot build a draft_this button)");
  }
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${idea.hook}*\n${idea.rationale}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Draft this" },
          action_id: DRAFT_THIS_ACTION,
          value: idea.id,
        },
      ],
    },
  ];
}
```

- [ ] **Step 4: Run the builder tests to verify they pass**

Run: `npm test -- digest`
Expected: the two new builder describes PASS. (The `assembleAndDeliver` tests still fail — they assert the old single-post shape; fixed next.)

- [ ] **Step 5: Rewrite `assembleAndDeliver` in `lib/digest.ts`**

Replace the entire `assembleAndDeliver` function (currently ~lines 148-186) with:

```ts
export async function assembleAndDeliver(
  profile: Profile,
): Promise<{ ideaCount: number; messageTs: string | null; recorded: boolean }> {
  const ideas = await selectTopCandidates(profile.id, 3);
  if (ideas.length === 0) return { ideaCount: 0, messageTs: null, recorded: false };

  // Open (or reuse) the bot↔rep DM.
  const opened = await slack.conversations.open({ users: profile.slack_user_id });
  const channel = opened.channel?.id;
  if (!channel) throw new Error("could not open DM channel for rep");

  // Header message first — its ts is the delivery marker we record.
  const headerFallback = `You have ${ideas.length} content idea${ideas.length === 1 ? "" : "s"} ready.`;
  const header = await slack.chat.postMessage({ channel, blocks: buildDigestHeaderBlocks(), text: headerFallback });
  const messageTs = header.ts ?? null;

  // Then one top-level message per idea; each becomes that idea's thread root.
  for (const idea of ideas) {
    await slack.chat.postMessage({ channel, blocks: buildIdeaBlocks(idea), text: `Draft idea: ${idea.hook}` });
  }

  // Record the delivery. The DM already went out — a logging failure must not surface as an
  // error (that would trigger a retry and a duplicate send).
  let recorded = false;
  try {
    const { error } = await scaClient().from("sca_digests").insert({
      rep_id: profile.id,
      idea_ids: ideas.map((i) => i.id),
      message_ts: messageTs,
    });
    if (error) {
      console.error("sca_digests insert failed after DM delivered", { repId: profile.id, messageTs, error });
    } else {
      recorded = true;
    }
  } catch (error) {
    console.error("sca_digests insert failed after DM delivered", { repId: profile.id, messageTs, error });
  }

  return { ideaCount: ideas.length, messageTs, recorded };
}
```

- [ ] **Step 6: Update the `assembleAndDeliver` tests**

In `lib/__tests__/digest.test.ts`, replace the happy-path test (`it("delivers the digest and records it on the happy path", ...)`) and the insert-failure test with:

```ts
  it("delivers a header + one message per idea and records it on the happy path", async () => {
    const ideas: Idea[] = [
      mk("idea-1", "Go quiet in the demo"),
      mk("idea-2", "Ask about budget owner"),
    ];
    vi.mocked(selectTopCandidates).mockResolvedValue(ideas);

    const result = await assembleAndDeliver(profile);

    // 1 header + 2 idea messages
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(slack.chat.postMessage).mock.calls;
    // First post is the header — no Draft this button.
    expect(JSON.stringify((calls[0][0] as any).blocks)).not.toContain(DRAFT_THIS_ACTION);
    // The two idea posts each carry a Draft this button with the idea id.
    expect(JSON.stringify((calls[1][0] as any).blocks)).toContain("idea-1");
    expect(JSON.stringify((calls[2][0] as any).blocks)).toContain("idea-2");

    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertArg = insertMock.mock.calls[0][0];
    expect(insertArg.rep_id).toBe(profile.id);
    expect(insertArg.idea_ids).toEqual(["idea-1", "idea-2"]);
    expect(insertArg.message_ts).toBe(MOCK_TS); // the header message ts

    expect(result).toEqual({ ideaCount: 2, messageTs: MOCK_TS, recorded: true });
  });

  it("does not throw when the sca_digests insert fails after the DM was delivered", async () => {
    const ideas: Idea[] = [mk("idea-1", "Go quiet in the demo")];
    vi.mocked(selectTopCandidates).mockResolvedValue(ideas);
    insertMock.mockResolvedValue({ error: { message: "boom" } });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await assembleAndDeliver(profile);

    // header + 1 idea message
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ideaCount: 1, messageTs: MOCK_TS, recorded: false });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
```

(The `"short-circuits on an empty candidate pool"` test is unchanged and stays.)

- [ ] **Step 7: Run the full unit suite**

Run: `npm test`
Expected: PASS — all digest tests green; no reference to `buildDigestBlocks` remains.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 9: Grep for surviving `buildDigestBlocks` references (must be empty)**

Run:
```bash
grep -rn "buildDigestBlocks" --include="*.ts" --include="*.tsx" . | grep -v node_modules
```
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add lib/digest.ts lib/__tests__/digest.test.ts
git diff --cached --name-only
git commit -m "feat(sca): digest as header + one message per idea"
```

---

## Task 4: Thread every draft-flow message under the clicked idea (`lib/draft.ts`)

Derive the idea-thread root from each interaction payload and thread every bot post in the draft flow under it. `lib/draft.ts` is I/O — no unit tests; verified by `tsc` + the existing suite staying green + the live pass.

**Files:**
- Modify: `lib/draft.ts`

**Interfaces:**
- Consumes: `buildOpenerBlocks(platform, opts?)` (Task 2 slimmed signature).
- Internal: adds `threadRoot(payload)`; adds a trailing `rootTs?: string` parameter to `claimAndDraft`, `commitOnePlatform`, `draftNow`, `draftOnePlatform`.

**Threading rule:** a post that *updates an existing in-thread message* (via `slack.chat.update`) needs no change — it stays where it is. Only *fresh* `postMessage` calls in the draft flow take `thread_ts: rootTs`. `handleDraftReplaceConfirm`/`handleDraftReplaceCancel` reuse the already-threaded confirm message, so they need **no change**.

- [ ] **Step 1: Add the `threadRoot` helper**

Add this near `messageCoords` at the bottom of `lib/draft.ts`:

```ts
// The idea-thread root for a button interaction: the thread the click happened in
// (message.thread_ts), or — for a top-level idea message — that message's own ts.
// undefined only if the payload lacks both, in which case posts fall back to top-level.
// Never throws.
function threadRoot(payload: unknown): string | undefined {
  const p = payload as {
    message?: { ts?: unknown; thread_ts?: unknown };
    container?: { message_ts?: unknown; thread_ts?: unknown };
  };
  const threadTs = p?.message?.thread_ts ?? p?.container?.thread_ts;
  if (typeof threadTs === "string") return threadTs;
  const ts = p?.message?.ts ?? p?.container?.message_ts;
  return typeof ts === "string" ? ts : undefined;
}
```

- [ ] **Step 2: Thread `rootTs` through `draftOnePlatform`**

Add a trailing `rootTs?: string` parameter and apply it to the fresh-opener post. Change the signature and the `else` branch of the opener post:

Signature (currently ends `reuseTs: string | undefined, knownCanvasId?: string | null,`):
```ts
async function draftOnePlatform(
  idea: Idea,
  profile: Profile,
  channel: string,
  moment: DemoMoment | null,
  platform: Platform,
  reuseTs: string | undefined,
  knownCanvasId?: string | null,
  rootTs?: string,
): Promise<{ ok: boolean; platform: Platform }> {
```

Opener post `else` branch (currently `const op = await slack.chat.postMessage({ channel, text: openerFallback, blocks: openerBlocks });`):
```ts
      const op = await slack.chat.postMessage({ channel, thread_ts: rootTs, text: openerFallback, blocks: openerBlocks });
```

- [ ] **Step 3: Thread `rootTs` through `draftNow`**

Add a trailing `rootTs?: string` parameter, pass it to `draftOnePlatform`, and apply it to the fresh retry-offer post. Replace `draftNow` with:

```ts
async function draftNow(
  ideaId: string,
  idea: Idea,
  profile: Profile,
  channel: string,
  moment: DemoMoment | null,
  platform: Platform,
  interimTs: string | undefined,
  knownCanvasId?: string | null,
  rootTs?: string,
): Promise<void> {
  const result = await draftOnePlatform(idea, profile, channel, moment, platform, interimTs, knownCanvasId, rootTs);
  if (result.ok) return;
  const blocks = buildRetryBlocks(ideaId, [platform], "");
  const text = `I couldn't finish the ${PLATFORM_LABEL[platform]} draft this time.`;
  try {
    if (interimTs) await slack.chat.update({ channel, ts: interimTs, text, blocks });
    else await slack.chat.postMessage({ channel, thread_ts: rootTs, text, blocks });
  } catch (e) {
    console.error("retry-offer post failed", { ideaId, platform, error: e });
  }
}
```

- [ ] **Step 4: Thread `rootTs` through `commitOnePlatform`**

Add a trailing `rootTs?: string` parameter; thread the replace-confirm post, the interim post, and the `draftNow` call. Replace `commitOnePlatform` with:

```ts
async function commitOnePlatform(
  ideaId: string,
  idea: Idea,
  profile: Profile,
  channel: string,
  moment: DemoMoment | null,
  platform: Platform,
  rootTs?: string,
): Promise<void> {
  try {
    const existing = await currentCanvasId(profile.id, platform);
    if (existing) {
      await slack.chat
        .postMessage({
          channel,
          thread_ts: rootTs,
          blocks: buildReplaceConfirmBlocks(ideaId, platform, idea.hook),
          text: `You already have a ${PLATFORM_LABEL[platform]} draft — replace it?`,
        })
        .catch((e) => console.error("replace-confirm post failed", { ideaId, platform, error: e }));
      return;
    }
    const interim = await slack.chat
      .postMessage({ channel, thread_ts: rootTs, text: `✍️ Drafting your ${PLATFORM_LABEL[platform]} draft in your voice… your canvas will appear at the top of this chat window in a few seconds.` })
      .catch(() => null);
    // We already know there is no canvas for this platform (existing is null), so pass
    // null to skip a redundant lookup inside draftOnePlatform.
    await draftNow(ideaId, idea, profile, channel, moment, platform, interim?.ts, null, rootTs);
  } catch (e) {
    console.error("commitOnePlatform failed", { ideaId, platform, error: e });
  }
}
```

- [ ] **Step 5: Thread `rootTs` through `claimAndDraft`**

Add a trailing `rootTs?: string` parameter and pass it to `commitOnePlatform`. Change the signature and the `Promise.all` map:

```ts
async function claimAndDraft(
  ideaId: string,
  profile: Profile,
  channel: string,
  platforms: Platform[],
  rootTs?: string,
): Promise<void> {
```
```ts
  await Promise.all(
    platforms.map((platform) => commitOnePlatform(ideaId, idea, profile, channel, moment, platform, rootTs)),
  );
```

- [ ] **Step 6: Derive + thread `rootTs` in `handleDraftThis`**

After the `ideaId`/`slackUserId`/`channel` guard, compute `rootTs`, thread the platform-choice post, thread the error posts, and pass `rootTs` to `claimAndDraft`. Replace the body from `const rootTs`-insertion through the `catch`:

```ts
  const rootTs = threadRoot(payload);

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, rootTs, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    const platforms = repPlatforms(profile);
    if (platforms.length > 1) {
      // Both channels: ask before committing (no claim yet).
      await slack.chat
        .postMessage({ channel, thread_ts: rootTs, blocks: buildPlatformChoiceBlocks(ideaId), text: "Which platform(s) will this be posted on?" })
        .catch((e) => console.error("platform choice post failed", { ideaId, error: e }));
      return;
    }
    await claimAndDraft(ideaId, profile, channel, platforms, rootTs);
  } catch (e) {
    await safePost(channel, rootTs, "Something went wrong — try again in a sec.");
    console.error("handleDraftThis failed (pre-claim)", { slackUserId, ideaId, error: e });
  }
```

- [ ] **Step 7: Derive + thread `rootTs` in `handleDraftPlatform`**

After the `parsePlatformValue` guard, compute `rootTs`, thread the error posts, and pass it to `claimAndDraft`. Replace the `try`/`catch` body:

```ts
  const rootTs = threadRoot(payload);

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, rootTs, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    await claimAndDraft(parsed.ideaId, profile, channel, platformsForSelection(parsed.selection), rootTs);
  } catch (e) {
    await safePost(channel, rootTs, "Something went wrong — try again in a sec.");
    console.error("handleDraftPlatform failed (pre-claim)", { slackUserId, ideaId: parsed.ideaId, error: e });
  }
```

- [ ] **Step 8: Derive + thread `rootTs` in `handleDraftRetry`**

After the platform guard, compute `rootTs`; thread the profile/idea error posts, the interim post, and pass `rootTs` to `draftNow`. Replace the `try`/`catch` body:

```ts
  const rootTs = threadRoot(payload);

  try {
    const profile = await getProfileBySlackUser(slackUserId);
    if (!profile) {
      await safePost(channel, rootTs, "I couldn't find your profile yet — finish onboarding and try again.");
      return;
    }
    const idea = await getIdea(parsed.ideaId, profile.id);
    if (!idea) {
      await safePost(channel, rootTs, "Hmm, I couldn't find that idea — grab another from your latest digest.");
      return;
    }
    // Idempotency: already have a draft session for this (idea, platform)? Nudge, don't duplicate.
    const existingTs = await threadTsForIdeaPlatform(profile.id, parsed.ideaId, platform);
    if (existingTs) {
      await safePost(channel, existingTs, `You're already drafting the ${PLATFORM_LABEL[platform]} version 👆`);
      return;
    }
    const interim = await slack.chat
      .postMessage({ channel, thread_ts: rootTs, text: `✍️ Retrying your ${PLATFORM_LABEL[platform]} draft… your canvas will appear at the top of this chat window in a few seconds.` })
      .catch(() => null);
    const meetingId =
      typeof (idea.source_ref as { meetingId?: unknown })?.meetingId === "string"
        ? (idea.source_ref as { meetingId: string }).meetingId
        : null;
    const moment =
      idea.source === "demo" && meetingId
        ? await readDemoMoment(meetingId).catch(() => null)
        : null;
    await draftNow(parsed.ideaId, idea, profile, channel, moment, platform, interim?.ts, undefined, rootTs);
  } catch (e) {
    await safePost(channel, rootTs, "Something went wrong — try again in a sec.");
    console.error("handleDraftRetry failed (pre-draft)", { slackUserId, ideaId: parsed.ideaId, error: e });
  }
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 10: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS — the full suite stays green (no unit tests target `draft.ts`; this confirms nothing else broke).

- [ ] **Step 11: Confirm `handleDraftReplaceConfirm`/`Cancel` were left unchanged**

Run:
```bash
git diff --cached lib/draft.ts | grep -nE "handleDraftReplace" || echo "replace handlers untouched (expected)"
```
Expected: `replace handlers untouched (expected)` — they reuse the already-threaded confirm message and correctly need no change.

- [ ] **Step 12: Commit**

```bash
git add lib/draft.ts
git diff --cached --name-only
git commit -m "feat(sca): thread all draft-flow messages under the clicked idea"
```

---

## Task 5: Live verification (Trent hand-off)

Not automated — the real proof. Deploy per the `sca-deployment-model` auto-memory (`vercel --prod --yes`, then `git push origin main` to keep the remote in sync), then fire a digest and click through in the DM.

**Files:** none (deploy + manual Slack verification).

- [ ] **Step 1: Pre-flight — clean tree, green checks**

Run:
```bash
git status
npx tsc --noEmit
npm test
```
Expected: clean tree, tsc exit 0, all tests green.

- [ ] **Step 2: Deploy to prod, then sync the git remote**

```bash
vercel --prod --yes
git push origin main
```
Expected: successful prod deploy; `main` even with origin.

- [ ] **Step 3: Fire a digest**

```bash
curl -sS -X POST https://sales-content-assistant.vercel.app/api/digest/generate -H "Authorization: Bearer $SCA_INTERNAL_KEY" -H "Content-Type: application/json" -d '{"slackUserId":"U_YOUR_SLACK_ID"}'
```
Expected: JSON `{ ideaCount: 1..3, ... }`. If `ideaCount: 0`, refill first (`/api/pool/refill`, same body) then re-run.

- [ ] **Step 4: Verify the digest layout**

Expected in the DM: one header message ("Here are a few things worth saying this week"), then one separate message per idea, each with its own "Draft this" button.

- [ ] **Step 5: Verify self-identifying canvas**

Click "Draft this" on an idea → its canvas is titled `"LinkedIn draft"` (or `"Instagram draft"`) and the **body opens with the idea's hook as a heading**. Draft a *second* idea for the same platform → Replace → the **same** canvas updates: the heading now shows the **new** hook, body is the new draft, title unchanged, no new canvas, no stub.

- [ ] **Step 6: Verify threaded drafting**

The drafting note, opener, and any replace-confirm/retry appear **as replies in the thread under the clicked idea's message** — not as new top-level messages. The main feed stays quiet.

- [ ] **Step 7: Verify the Both-rep case**

As a both-channel rep: "Draft this" → the platform question and both drafts nest under the one idea thread; the two canvases (one LI, one IG) sit at the top, each self-identifying via its hook heading.

- [ ] **Step 8: Report**

Confirm: per-idea threads, self-identifying canvases on reuse, clean feed, no tombstones. Update `.superpowers/sdd/progress.md`.

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Stable per-platform canvas title → Task 1 (`canvasName`) + Task 2 (create uses it). ✅
- Hook as H1 in body, on create *and* reuse-edit → Task 1 (`canvasDocument`) + Task 2 (`draftOnePlatform` builds `document`, passes to both `editCanvas` and `createCanvasInDM`). ✅
- Opener copy stops leaning on the hook-title → Task 2 (`buildOpenerBlocks` rewrite). ✅
- Digest = header + one message per idea → Task 3 (`buildDigestHeaderBlocks`/`buildIdeaBlocks` + `assembleAndDeliver`). ✅
- Thread all draft-flow posts under the clicked idea; `rootTs = message.thread_ts ?? message.ts` → Task 4 (`threadRoot` + threading through the post chain). ✅
- No schema migration; row keys on opener reply ts → Task 4 leaves the `sca_thread_map` insert unchanged. ✅
- `sca_digests.message_ts` = header ts → Task 3 (`assembleAndDeliver` records the header ts). ✅
- Both-rep nesting, step-7 deferred → Task 4 (both platforms threaded under one `rootTs`); no step-7 code added. ✅
- Testing split (pure builders unit-tested; `draft.ts` via tsc + live) → Tasks 1/2/3 carry unit tests; Task 4 is tsc + live. ✅

**2. Placeholder scan:** No "TBD"/"handle appropriately"/"similar to Task N"/"write tests for the above" — every code and test step carries complete code. ✅

**3. Type consistency:**
- `canvasName(platform: Platform): string` / `canvasDocument(hook, body): string` — defined Task 1, consumed Task 2 (`draftOnePlatform`) with matching args. ✅
- `buildOpenerBlocks(platform, opts?)` — slimmed in Task 2 with its only caller (`draftOnePlatform`) updated in the same commit; Task 4 re-shows that call as `buildOpenerBlocks(platform, { wasRedacted })`. ✅
- `buildDigestHeaderBlocks()` / `buildIdeaBlocks(idea)` — defined Task 3, consumed by `assembleAndDeliver` in the same task. ✅
- `rootTs?: string` — appended as the trailing param on `draftOnePlatform`, `draftNow`, `commitOnePlatform`, `claimAndDraft` consistently in Task 4; `draftNow`/`draftOnePlatform` keep `knownCanvasId?` before `rootTs?`, and every call site passes them positionally in that order. ✅
- `threadRoot(payload): string | undefined` — one definition (Task 4), used by the three entry handlers. ✅

**Note for the reviewer:** Task 4 deliberately leaves `handleDraftReplaceConfirm`/`handleDraftReplaceCancel` unchanged — they reuse the confirm message, which `commitOnePlatform` already posted into the thread, so the replace/keep flow is threaded transitively. Step 11 asserts this.
