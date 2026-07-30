# Phase 1 — Plan 2: Onboarding Web Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the magic-link web onboarding — a rep opens `/onboard/[token]`, sees a voice profile **pre-filled from their own demos**, tightens it in a ~5-minute edit, saves, and their profile flips `active`.

**Architecture:** A server-rendered page resolves the profile from the URL token (fast DB read) and hands a client form the initial state. On first visit the form fetches `/api/onboard/skim` (reads the rep's demos from the RAG read-only, derives a draft voice via the Plan 1 mining lib) and shows a loading state while it runs; the rep edits the pre-filled fields and posts to `/api/onboard/save`, which validates server-side, writes the profile, and activates it. Pure logic (payload validation, draft shaping) is unit-tested; the routes + page + real RAG/AI/Supabase round-trip are verified with one live Vercel-preview pass (the Phase-0 / Plan-1 pattern, since secrets can't run locally here).

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, React 19 Client Components, `zod`, Vitest. Consumes Plan 1 libs (`lib/profiles`, `lib/mining`).

## Global Constraints

- Project root: `/Users/trentluecke/dev/Claude-Projects/Sales Content Assisnt` (inside the `Claude-Projects` monorepo — never `git add -A`; stage only this subdir and confirm with `git diff --cached --name-only`).
- Runtime: Node.js (Vercel default). Language: TypeScript, App Router only.
- **Next.js 16:** dynamic-route `params` is a `Promise` — `await params` in server components and route handlers. Route handlers are `export async function GET/POST(req: Request)`. Mark DB-reading pages/routes `export const dynamic = "force-dynamic"` so the build never tries to prerender them (env secrets exist only on Vercel, not at build).
- Model: `claude-sonnet-5` via `@ai-sdk/anthropic` (already wired in `lib/mining`).
- Secrets never land in local files (env redaction writes `[SENSITIVE]`) — all secret-using code is verified on a Vercel deploy, not a local script. `SCA_SUPABASE_*` / `RAG_SUPABASE_*` / `ANTHROPIC_API_KEY` live in Vercel preview env (set in Plan 1). Unit tests mock or avoid all I/O.
- Hard rule: rep-facing generated text contains **no customer/prospect/deal names** — anonymized patterns only. (Onboarding surfaces the rep's *own* voice/traits, not generated content, so this plan carries no new leakage surface; the guardrail lands in the draft-loop plan.)
- Isolation: no module-global mutable *rep* state. Skim/save resolve the profile fresh from the request's token; the client never supplies `rep_id`.
- Test file convention: `lib/__tests__/<name>.test.ts` (matches `vitest.config.ts`, env `node`).

## Consumed Plan 1 interfaces (verbatim signatures — do not re-implement)

From `lib/profiles.ts`:
- `interface Profile { id: string; avoma_rep_name: string; slack_user_id: string; magic_token: string; display_name: string | null; voice_traits: unknown[]; background: string | null; angle: string | null; channels: unknown[]; admired_post: string | null; status: "draft" | "active"; }`
- `getProfileByToken(token: string): Promise<Profile | null>`
- `getProfileBySlackUser(slackUserId: string): Promise<Profile | null>`
- `createDraftProfile(input: { avomaRepName: string; slackUserId: string; displayName?: string }): Promise<Profile>`
- `saveProfile(id: string, patch: Partial<Profile>, activate: boolean): Promise<void>`

From `lib/mining.ts`:
- `interface VoiceTrait { name: string; description: string; examples: string[] }`
- `readRepDemos(avomaRepName: string, limit?: number): Promise<DemoTranscript[]>`
- `deriveVoiceProfile(demos: DemoTranscript[]): Promise<{ traits: VoiceTrait[]; background: string; angle: string }>`

---

### Task 1: Onboarding pure logic — draft shaping + save-payload validation

The only unit-testable surface in this plan: the shape of the draft the form renders, the camelCase↔snake_case mapping to `Profile`, and the server-side validation guard for the save payload.

**Files:**
- Create: `lib/onboarding.ts`
- Test: `lib/__tests__/onboarding.test.ts`

**Interfaces:**
- Consumes: `Profile` (from `lib/profiles`).
- Produces types: `VoiceTraitInput = { name: string; description: string; examples: string[] }`, `DraftProfile = { displayName: string; traits: VoiceTraitInput[]; background: string; angle: string; channels: string[]; admiredPost: string }`, `SavePayload` (zod-inferred).
- Produces pure: `hasBeenSkimmed(p: Profile): boolean`, `draftFromProfile(p: Profile): DraftProfile`, `draftFromVoice(p: Profile, voice: { traits: VoiceTraitInput[]; background: string; angle: string }): DraftProfile`, `parseSavePayload(raw: unknown): { ok: true; value: SavePayload } | { ok: false; error: string }`, `savePayloadToPatch(v: SavePayload): Partial<Profile>`. Consumed by the skim route (Task 2), save route (Task 3), and page/form (Task 4).

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/onboarding.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  hasBeenSkimmed,
  draftFromProfile,
  draftFromVoice,
  parseSavePayload,
  savePayloadToPatch,
} from "@/lib/onboarding";
import type { Profile } from "@/lib/profiles";

const baseProfile = (over: Partial<Profile> = {}): Profile => ({
  id: "rep-1",
  avoma_rep_name: "Trent Luecke",
  slack_user_id: "U04ECG6KEA3",
  magic_token: "tok",
  display_name: null,
  voice_traits: [],
  background: null,
  angle: null,
  channels: [],
  admired_post: null,
  status: "draft",
  ...over,
});

describe("hasBeenSkimmed", () => {
  it("is false when voice_traits is empty", () => {
    expect(hasBeenSkimmed(baseProfile())).toBe(false);
  });
  it("is true once voice_traits has entries", () => {
    expect(hasBeenSkimmed(baseProfile({ voice_traits: [{ name: "x", description: "", examples: [] }] }))).toBe(true);
  });
});

describe("draftFromProfile", () => {
  it("maps stored snake_case fields to the camelCase draft, nulls to empty strings", () => {
    const d = draftFromProfile(baseProfile({
      display_name: "Trent",
      voice_traits: [{ name: "Direct", description: "no fluff", examples: ["ex1"] }],
      background: "ex-coach",
      angle: "outsider",
      channels: ["LinkedIn"],
      admired_post: "some post",
    }));
    expect(d).toEqual({
      displayName: "Trent",
      traits: [{ name: "Direct", description: "no fluff", examples: ["ex1"] }],
      background: "ex-coach",
      angle: "outsider",
      channels: ["LinkedIn"],
      admiredPost: "some post",
    });
  });
});

describe("draftFromVoice", () => {
  it("uses derived voice + the profile's display name, with empty channels/admiredPost", () => {
    const d = draftFromVoice(baseProfile({ display_name: "Trent" }), {
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "guessed bg",
      angle: "guessed angle",
    });
    expect(d).toEqual({
      displayName: "Trent",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "guessed bg",
      angle: "guessed angle",
      channels: [],
      admiredPost: "",
    });
  });
});

describe("parseSavePayload", () => {
  it("accepts a well-formed payload", () => {
    const r = parseSavePayload({
      token: "tok",
      displayName: "Trent",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: "angle",
      channels: ["LinkedIn"],
      admiredPost: "post",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a missing token with an error string", () => {
    const r = parseSavePayload({ traits: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/token/);
  });
  it("defaults optional fields so a minimal payload is valid", () => {
    const r = parseSavePayload({ token: "tok", traits: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.displayName).toBe("");
      expect(r.value.channels).toEqual([]);
    }
  });
});

describe("savePayloadToPatch", () => {
  it("maps camelCase payload to a snake_case Profile patch, empty strings to null", () => {
    const patch = savePayloadToPatch({
      token: "tok",
      displayName: "",
      traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: "",
      channels: ["LinkedIn"],
      admiredPost: "",
    });
    expect(patch).toEqual({
      display_name: null,
      voice_traits: [{ name: "Direct", description: "d", examples: ["e"] }],
      background: "bg",
      angle: null,
      channels: ["LinkedIn"],
      admired_post: null,
    });
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- onboarding`
Expected: FAIL — `@/lib/onboarding` not found.

- [ ] **Step 3: Implement**

Create `lib/onboarding.ts`:
```ts
import { z } from "zod";
import type { Profile } from "@/lib/profiles";

export interface VoiceTraitInput {
  name: string;
  description: string;
  examples: string[];
}

export interface DraftProfile {
  displayName: string;
  traits: VoiceTraitInput[];
  background: string;
  angle: string;
  channels: string[];
  admiredPost: string;
}

// True once a skim (or a prior save) has populated the voice profile — the page
// then pre-fills from stored data instead of re-running the expensive skim.
export function hasBeenSkimmed(p: Profile): boolean {
  return Array.isArray(p.voice_traits) && p.voice_traits.length > 0;
}

export function draftFromProfile(p: Profile): DraftProfile {
  return {
    displayName: p.display_name ?? "",
    traits: (p.voice_traits as VoiceTraitInput[]) ?? [],
    background: p.background ?? "",
    angle: p.angle ?? "",
    channels: (p.channels as string[]) ?? [],
    admiredPost: p.admired_post ?? "",
  };
}

export function draftFromVoice(
  p: Profile,
  voice: { traits: VoiceTraitInput[]; background: string; angle: string },
): DraftProfile {
  return {
    displayName: p.display_name ?? "",
    traits: voice.traits,
    background: voice.background,
    angle: voice.angle,
    channels: [],
    admiredPost: "",
  };
}

const saveSchema = z.object({
  token: z.string().min(1),
  displayName: z.string().max(120).default(""),
  traits: z
    .array(
      z.object({
        name: z.string().max(120),
        description: z.string().max(500),
        examples: z.array(z.string().max(1000)).max(10),
      }),
    )
    .max(12),
  background: z.string().max(4000).default(""),
  angle: z.string().max(4000).default(""),
  channels: z.array(z.string().max(60)).max(10).default([]),
  admiredPost: z.string().max(8000).default(""),
});

export type SavePayload = z.infer<typeof saveSchema>;

export function parseSavePayload(
  raw: unknown,
): { ok: true; value: SavePayload } | { ok: false; error: string } {
  const r = saveSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const error = r.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

// Map the validated (camelCase) payload to a snake_case Profile patch.
// Empty strings become null so the DB holds NULL, not "".
export function savePayloadToPatch(v: SavePayload): Partial<Profile> {
  return {
    display_name: v.displayName || null,
    voice_traits: v.traits,
    background: v.background || null,
    angle: v.angle || null,
    channels: v.channels,
    admired_post: v.admiredPost || null,
  };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- onboarding`
Expected: PASS (all describe blocks green). Also run `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/onboarding.ts lib/__tests__/onboarding.test.ts
git diff --cached --name-only    # confirm all under "Sales Content Assisnt/"
git commit -m "feat(sca): onboarding pure logic — draft shaping + save-payload validation"
```

---

### Task 2: `/api/onboard/skim` route — derive a draft profile from demos

Thin route: resolve profile from token → read demos → derive voice → return a `DraftProfile`. Handles the no-demos case without erroring. No unit test (needs real RAG + AI + secrets); verified live in Task 5, matching Plan 1's approach.

**Files:**
- Create: `app/api/onboard/skim/route.ts`

**Interfaces:**
- Consumes: `getProfileByToken` (profiles), `readRepDemos` / `deriveVoiceProfile` (mining), `draftFromVoice` (onboarding).
- Produces: `POST /api/onboard/skim` — body `{ token: string }` → `200` `DraftProfile` JSON, `400` on bad/missing token, `404` when no profile matches.

- [ ] **Step 1: Implement the route**

Create `app/api/onboard/skim/route.ts`:
```ts
import { getProfileByToken } from "@/lib/profiles";
import { readRepDemos, deriveVoiceProfile } from "@/lib/mining";
import { draftFromVoice } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // reads demos + runs the voice model

export async function POST(req: Request) {
  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "missing token" }, { status: 400 });
  }

  // Resolve the rep fresh from the token — never trust a client-supplied id.
  const profile = await getProfileByToken(token);
  if (!profile) return new Response("not found", { status: 404 });

  const demos = await readRepDemos(profile.avoma_rep_name, 6);
  if (demos.length === 0) {
    // No demos indexed yet — return an empty draft the rep can fill by hand.
    return Response.json(draftFromVoice(profile, { traits: [], background: "", angle: "" }));
  }

  const voice = await deriveVoiceProfile(demos);
  return Response.json(draftFromVoice(profile, voice));
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Live behavior is proven in Task 5 — it needs real secrets.)

- [ ] **Step 3: Commit**

```bash
git add app/api/onboard/skim/route.ts
git commit -m "feat(sca): /api/onboard/skim — derive draft voice profile from demos"
```

---

### Task 3: `/api/onboard/save` route — validate, persist, activate

Thin route: validate the payload server-side, resolve the profile from its token, write the patch, flip `status=active`.

**Files:**
- Create: `app/api/onboard/save/route.ts`

**Interfaces:**
- Consumes: `parseSavePayload` / `savePayloadToPatch` (onboarding), `getProfileByToken` / `saveProfile` (profiles).
- Produces: `POST /api/onboard/save` — body is the `SavePayload` shape → `200` `{ ok: true }`, `400` on invalid payload (with `error` string), `404` when no profile matches the token.

- [ ] **Step 1: Implement the route**

Create `app/api/onboard/save/route.ts`:
```ts
import { getProfileByToken, saveProfile } from "@/lib/profiles";
import { parseSavePayload, savePayloadToPatch } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const parsed = parseSavePayload(raw);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // Resolve the rep fresh from the token — the client never sends a rep_id.
  const profile = await getProfileByToken(parsed.value.token);
  if (!profile) return new Response("not found", { status: 404 });

  await saveProfile(profile.id, savePayloadToPatch(parsed.value), true);
  return Response.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/onboard/save/route.ts
git commit -m "feat(sca): /api/onboard/save — validate, persist, activate profile"
```

---

### Task 4: `/onboard/[token]` page + client form

The page (server component) resolves the profile from the URL token and hands the client form its initial state. The form skims on first visit (with a loading state), lets the rep edit every field, and posts to save.

**Files:**
- Create: `app/onboard/[token]/page.tsx`
- Create: `app/onboard/[token]/OnboardForm.tsx`
- Create: `app/onboard/[token]/onboard.module.css`

**Interfaces:**
- Consumes: `getProfileByToken` (profiles), `hasBeenSkimmed` / `draftFromProfile` / `DraftProfile` (onboarding), the skim + save routes (Tasks 2-3).
- Produces: the route `/onboard/[token]` (no exported code consumed by later tasks).

- [ ] **Step 1: Write the CSS module**

Create `app/onboard/[token]/onboard.module.css`:
```css
.wrap {
  max-width: 640px;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  font: 15px/1.5 system-ui, -apple-system, sans-serif;
}
.h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
.sub { color: #666; margin: 0 0 2rem; }
.status { padding: 2rem 0; color: #666; }
.field { margin-bottom: 1.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
.label { font-weight: 600; }
.hint { color: #888; font-size: 0.85rem; }
.input, .textarea {
  width: 100%; padding: 0.55rem 0.7rem; border: 1px solid #ccc;
  border-radius: 8px; font: inherit; box-sizing: border-box;
}
.textarea { resize: vertical; min-height: 4.5rem; }
.trait { border: 1px solid #e5e5e5; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
.traitHead { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.6rem; }
.remove {
  margin-left: auto; background: none; border: none; color: #c00;
  cursor: pointer; font-size: 0.85rem;
}
.examples { display: flex; flex-direction: column; gap: 0.4rem; }
.addRow { display: flex; gap: 0.75rem; margin: 0.25rem 0 2rem; }
.ghost {
  background: none; border: 1px dashed #bbb; border-radius: 8px;
  padding: 0.5rem 0.9rem; cursor: pointer; font: inherit; color: #444;
}
.channels { display: flex; gap: 1rem; flex-wrap: wrap; }
.channel { display: flex; align-items: center; gap: 0.4rem; }
.submit {
  background: #111; color: #fff; border: none; border-radius: 10px;
  padding: 0.8rem 1.4rem; font: inherit; font-weight: 600; cursor: pointer;
}
.submit:disabled { opacity: 0.5; cursor: default; }
.error { color: #c00; margin-top: 1rem; }
.done { padding: 3rem 0; text-align: center; }
```

- [ ] **Step 2: Write the page (server component)**

Create `app/onboard/[token]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getProfileByToken } from "@/lib/profiles";
import { hasBeenSkimmed, draftFromProfile } from "@/lib/onboarding";
import { OnboardForm } from "./OnboardForm";
import styles from "./onboard.module.css";

export const dynamic = "force-dynamic";

export default async function OnboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const profile = await getProfileByToken(token);
  if (!profile) notFound();

  // If a skim (or prior save) already populated the profile, pre-fill from
  // stored data and skip the expensive re-skim; otherwise let the form skim.
  const initialDraft = hasBeenSkimmed(profile) ? draftFromProfile(profile) : null;

  return (
    <main className={styles.wrap}>
      <h1 className={styles.h1}>Let&apos;s tune your voice</h1>
      <p className={styles.sub}>
        We read a few of your demos and took a first guess. Tighten anything that
        doesn&apos;t sound like you, add a couple of specifics, and you&apos;re set.
      </p>
      <OnboardForm token={token} initialDraft={initialDraft} />
    </main>
  );
}
```

- [ ] **Step 3: Write the client form**

Create `app/onboard/[token]/OnboardForm.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import type { DraftProfile, VoiceTraitInput } from "@/lib/onboarding";
import styles from "./onboard.module.css";

const CHANNELS = ["LinkedIn", "Instagram"];

type Phase = "skimming" | "editing" | "saving" | "done" | "error";

export function OnboardForm({
  token,
  initialDraft,
}: {
  token: string;
  initialDraft: DraftProfile | null;
}) {
  const [draft, setDraft] = useState<DraftProfile | null>(initialDraft);
  const [phase, setPhase] = useState<Phase>(initialDraft ? "editing" : "skimming");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (initialDraft) return; // already have a draft; no skim needed
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/onboard/skim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error(`Couldn't read your demos (${res.status})`);
        const d = (await res.json()) as DraftProfile;
        if (!cancelled) {
          setDraft(d);
          setPhase("editing");
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMsg((e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, initialDraft]);

  if (phase === "skimming") {
    return <p className={styles.status}>Reading your demos and drafting your voice…</p>;
  }
  if (phase === "done") {
    return (
      <div className={styles.done}>
        <h2>You&apos;re all set.</h2>
        <p>The assistant will start sending you post ideas in Slack.</p>
      </div>
    );
  }
  if (phase === "error" && !draft) {
    return <p className={styles.error}>{errorMsg} — refresh to try again.</p>;
  }
  if (!draft) return null;

  const set = (patch: Partial<DraftProfile>) => setDraft({ ...draft, ...patch });

  const setTrait = (i: number, patch: Partial<VoiceTraitInput>) =>
    set({ traits: draft.traits.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const addTrait = () =>
    set({ traits: [...draft.traits, { name: "", description: "", examples: [""] }] });

  const removeTrait = (i: number) =>
    set({ traits: draft.traits.filter((_, j) => j !== i) });

  const toggleChannel = (c: string) =>
    set({
      channels: draft.channels.includes(c)
        ? draft.channels.filter((x) => x !== c)
        : [...draft.channels, c],
    });

  const submit = async () => {
    setPhase("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/onboard/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setPhase("done");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setPhase("editing");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <label className={styles.label}>Your name</label>
        <input
          className={styles.input}
          value={draft.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Voice traits</label>
        <span className={styles.hint}>
          How you actually sound, pulled from your demos. Fix any that feel off.
        </span>
      </div>
      {draft.traits.map((t, i) => (
        <div key={i} className={styles.trait}>
          <div className={styles.traitHead}>
            <input
              className={styles.input}
              placeholder="Trait name"
              value={t.name}
              onChange={(e) => setTrait(i, { name: e.target.value })}
            />
            <button type="button" className={styles.remove} onClick={() => removeTrait(i)}>
              remove
            </button>
          </div>
          <input
            className={styles.input}
            placeholder="One-line description"
            value={t.description}
            onChange={(e) => setTrait(i, { description: e.target.value })}
          />
          <div className={styles.examples} style={{ marginTop: "0.5rem" }}>
            {t.examples.map((ex, k) => (
              <input
                key={k}
                className={styles.input}
                placeholder="Example line"
                value={ex}
                onChange={(e) =>
                  setTrait(i, {
                    examples: t.examples.map((x, j) => (j === k ? e.target.value : x)),
                  })
                }
              />
            ))}
            <button
              type="button"
              className={styles.ghost}
              onClick={() => setTrait(i, { examples: [...t.examples, ""] })}
            >
              + add example
            </button>
          </div>
        </div>
      ))}
      <div className={styles.addRow}>
        <button type="button" className={styles.ghost} onClick={addTrait}>
          + add a trait
        </button>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Background</label>
        <span className={styles.hint}>What you did before / what you know deeply.</span>
        <textarea
          className={styles.textarea}
          value={draft.background}
          onChange={(e) => set({ background: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Your angle</label>
        <span className={styles.hint}>The distinctive POV only you bring.</span>
        <textarea
          className={styles.textarea}
          value={draft.angle}
          onChange={(e) => set({ angle: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Where you post</label>
        <div className={styles.channels}>
          {CHANNELS.map((c) => (
            <label key={c} className={styles.channel}>
              <input
                type="checkbox"
                checked={draft.channels.includes(c)}
                onChange={() => toggleChannel(c)}
              />
              {c}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>A post you admire (optional)</label>
        <span className={styles.hint}>Paste one whose style you&apos;d like to echo.</span>
        <textarea
          className={styles.textarea}
          value={draft.admiredPost}
          onChange={(e) => set({ admiredPost: e.target.value })}
        />
      </div>

      <button type="submit" className={styles.submit} disabled={phase === "saving"}>
        {phase === "saving" ? "Saving…" : "Save and finish"}
      </button>
      {errorMsg ? <p className={styles.error}>{errorMsg}</p> : null}
    </form>
  );
}
```

- [ ] **Step 4: Typecheck and build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: typecheck clean; build succeeds. The `/onboard/[token]` route shows as dynamic (ƒ) in the build output, not statically prerendered (○) — confirming `force-dynamic` took effect and the build never hit the DB.

- [ ] **Step 5: Commit**

```bash
git add app/onboard/
git diff --cached --name-only    # confirm all under "Sales Content Assisnt/"
git commit -m "feat(sca): onboarding page + client form (skim, edit, save)"
```

---

### Task 5: Live integration verification (temp link route)

Prove the real round-trip for the guinea pig (Trent), the Phase-0 way: a temporary owner route to mint the onboarding link (local files can't hold secrets, so we can't query Supabase from a local script). Open the link, confirm the skim pre-fills real traits from Trent's demos, edit + save, confirm the profile flips `active` with the saved fields. Then remove the temp route.

**Files:**
- Create (temporary): `app/api/onboard/link/route.ts`

**Interfaces:**
- Consumes: `getProfileBySlackUser` / `createDraftProfile` (profiles).

- [ ] **Step 1: Write the temporary link route**

Create `app/api/onboard/link/route.ts`:
```ts
import { getProfileBySlackUser, createDraftProfile } from "@/lib/profiles";

export const dynamic = "force-dynamic";

const OWNER_SLACK = "U04ECG6KEA3";
const OWNER_AVOMA = "Trent Luecke";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== "onboardlink") {
    return new Response("forbidden", { status: 403 });
  }
  const slack = url.searchParams.get("slack") ?? OWNER_SLACK;
  const avoma = url.searchParams.get("avoma") ?? OWNER_AVOMA;

  let p = await getProfileBySlackUser(slack);
  if (!p) {
    p = await createDraftProfile({
      avomaRepName: avoma,
      slackUserId: slack,
      displayName: avoma.split(/\s+/)[0],
    });
  }
  return Response.json({
    onboardUrl: `${url.origin}/onboard/${p.magic_token}`,
    status: p.status,
  });
}
```

- [ ] **Step 2: Deploy and mint the link**

Run:
```bash
npm run build && vercel deploy
```
Then hit `https://<preview-url>/api/onboard/link?key=onboardlink`.
Expected: JSON `{ onboardUrl: "https://<preview-url>/onboard/<token>", status: "draft" }`.

- [ ] **Step 3: Walk the onboarding round-trip in a browser**

Open the `onboardUrl`. Expected, in order:
1. The page renders immediately with "Reading your demos and drafting your voice…".
2. Within ~30s the form fills in: your name, **3-8 real voice traits with verbatim example lines from your demos**, a guessed background, and a guessed angle.
3. Edit at least one trait and add a background specific, tick LinkedIn, and click **Save and finish** → the "You're all set" screen appears.

Record the observed trait names + one example line in the findings doc as evidence the skim read real demos.

- [ ] **Step 4: Confirm persistence + activation**

Re-hit `https://<preview-url>/api/onboard/link?key=onboardlink`.
Expected: same `onboardUrl`, now `status: "active"`. In the SCA Supabase Table editor, confirm the `sca_profiles` row for `slack_user_id = U04ECG6KEA3` has `status = active`, `voice_traits` populated with your edits, and `channels` includes `LinkedIn`. Reload the `onboardUrl` and confirm it pre-fills from stored data **without** a skim delay (proves `hasBeenSkimmed` short-circuits the re-skim).

- [ ] **Step 5: Remove the temporary route and redeploy**

Run:
```bash
rm -rf app/api/onboard/link
npm run build && vercel deploy
```
Confirm `GET /api/onboard/link?key=onboardlink` now returns 404.

- [ ] **Step 6: Commit**

```bash
git add app/                     # stages the temp-route deletion, scoped to this project
git diff --cached --name-only    # confirm all under "Sales Content Assisnt/" — NEVER `git add -A` in this monorepo
git commit -m "chore(sca): verify onboarding round-trip live for Trent (temp link route added + removed)"
```

---

## Plan 2 Exit Criteria

- `lib/onboarding.ts` implemented; all unit tests green; `tsc --noEmit` clean; `npm run build` succeeds.
- `/onboard/[token]` renders a demo-derived draft, is editable, and saves; `/api/onboard/skim` and `/api/onboard/save` work over the live preview.
- Live pass proved: Trent opens his link → real traits pre-fill from his demos → he edits + saves → `sca_profiles` row is `active` with his edits; a reload pre-fills without re-skimming.
- Temporary link route removed; no owner-admin surface shipped (deferred to Phase 2 multi-rep).

## Deferred / carry-forward (deliberate, not gaps)

- **Magic-link expiry / one-time-use** — not built. A link exposes only that one rep's onboarding (low sensitivity) and the guinea pig is the owner. Revisit before any teammate gets a link (Phase 2).
- **Owner link-minting UI** — Phase 1 mints links via the temp route above. A real key-protected owner surface (generate link per rep, list statuses) lands with Phase 2 multi-rep rollout.
- **Anonymization guardrail in generation** — no new surface here (onboarding shows the rep's own voice, not generated content). Still owed in the draft-loop plan: forbid `prospect_name` + a post-generation second-pass check.

**Next:** Plan 3 (Pool refill) — `/api/pool/refill` mines a rep's not-yet-mined demos into `sca_ideas` candidates with dedup, reusing `readRepDemos` / `mineIdeas` / `dedupeIdeas` / `insertIdeas`. Then Plan 4 (digest + Draft-this + Canvas loop), Plan 5 (weekly cron, last).
```