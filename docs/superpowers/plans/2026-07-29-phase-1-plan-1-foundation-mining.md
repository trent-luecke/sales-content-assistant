# Phase 1 — Plan 1: Foundation + Mining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the SCA data layer and the demo-mining engine: given a rep, read their demos from the Avoma RAG, derive a draft voice profile, and mine a scored, deduped pool of content ideas into the SCA database.

**Architecture:** A dedicated SCA Supabase project holds the assistant's tables; a read-only connection into the RAG project supplies demos. Pure logic (dedup, ranking, PII check, response shaping) is unit-tested; the DB and AI I/O are verified with one live integration pass on a deployed Vercel preview (the Phase-0 spike pattern, since local files can't hold real secrets here).

**Tech Stack:** TypeScript, Next.js App Router on Vercel, `@supabase/supabase-js`, Vercel AI SDK (`ai` + `@ai-sdk/anthropic`, model `claude-sonnet-5`), Vitest.

## Global Constraints

- Project root: `/Users/trentluecke/dev/Claude-Projects/Sales Content Assisnt` (inside the `Claude-Projects` monorepo — never `git add -A`; stage only this subdir and confirm with `git diff --cached --name-only`).
- Runtime: Node.js (Vercel default). Language: TypeScript, App Router only.
- Model: `claude-sonnet-5` via `@ai-sdk/anthropic`.
- Secrets never land in local files (env redaction writes `[SENSITIVE]`) — all secret-using code is verified on a Vercel deploy, not a local script. Unit tests mock all I/O.
- Hard rule: generated hook/rationale text shown to a rep contains **no customer/prospect/deal names** — anonymized patterns only. `source_ref` (internal, never shown) may hold real identifiers.
- Isolation: no module-global mutable *rep* state; every function takes `rep_id`/rep context explicitly. (Stateless DB/AI *clients* may be module-memoized — they carry no rep identity.)
- Test file convention: `lib/__tests__/<name>.test.ts` (matches Phase 0 `vitest.config.ts`).

---

### Task 0: SCA Supabase project, schema, read-only RAG role, env

Provision the dedicated SCA project and the isolated read path into the RAG. Human-only console steps are called out — an agent cannot click through Supabase dashboards.

**Files:**
- Create: `db/schema.sql`
- Modify: `.env.local` (git-ignored; add new keys)

**Interfaces:**
- Produces env var names every later task consumes: `SCA_SUPABASE_URL`, `SCA_SUPABASE_SERVICE_KEY`, `RAG_SUPABASE_URL`, `RAG_SUPABASE_READONLY_KEY`. (`ANTHROPIC_API_KEY` already exists from Phase 0.)
- Produces tables: `sca_profiles`, `sca_ideas`, `sca_thread_map`, `sca_digests`.

- [ ] **Step 1: Human — create the SCA Supabase project**

At supabase.com → New Project (name `sales-content-assistant`). When ready: Project Settings → API → copy the **Project URL** and the **`service_role`** key.

- [ ] **Step 2: Human — create a read-only role/key in the RAG project**

In the *existing* RAG project (`jffuedeczfehgjzjldvm`) → SQL editor, run:
```sql
create role sca_readonly nologin;
grant usage on schema public to sca_readonly;
grant select on public.meetings, public.chunks to sca_readonly;
```
Then create a limited API key for it (Project Settings → API keys → new publishable/secret key scoped to `sca_readonly` if the project supports scoped keys; otherwise use the RAG `anon` key with an RLS `select` policy for `sca_readonly`). Record it as `RAG_SUPABASE_READONLY_KEY`. If scoped keys aren't available on the plan, fall back to the RAG service key **read-only by convention** and note the compromise in `db/schema.sql` comments.

- [ ] **Step 3: Write the SCA schema file**

Create `db/schema.sql`:
```sql
-- SCA (Sales Content Assistant) schema. Applied to the dedicated SCA Supabase project.
create extension if not exists pgcrypto;

create table sca_profiles (
  id uuid primary key default gen_random_uuid(),
  avoma_rep_name text not null,
  slack_user_id text not null unique,
  magic_token text not null unique,
  display_name text,
  voice_traits jsonb default '[]'::jsonb,
  background text,
  angle text,
  channels jsonb default '[]'::jsonb,
  admired_post text,
  status text not null default 'draft' check (status in ('draft','active')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table sca_ideas (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references sca_profiles(id) on delete cascade,
  source text not null check (source in ('demo','organic')),
  source_ref jsonb default '{}'::jsonb,
  hook text not null,
  rationale text,
  score double precision not null default 0,
  status text not null default 'candidate' check (status in ('candidate','used','rejected')),
  created_at timestamptz default now(),
  used_at timestamptz
);
create index on sca_ideas (rep_id, status, score desc);

create table sca_thread_map (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references sca_profiles(id) on delete cascade,
  slack_channel text not null,
  thread_ts text not null,
  canvas_id text,
  idea_id uuid references sca_ideas(id) on delete set null,
  created_at timestamptz default now(),
  unique (slack_channel, thread_ts)
);

create table sca_digests (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references sca_profiles(id) on delete cascade,
  idea_ids jsonb default '[]'::jsonb,
  message_ts text,
  delivered_at timestamptz default now()
);

-- Deny-all RLS; the service key (used only server-side) bypasses it.
alter table sca_profiles enable row level security;
alter table sca_ideas enable row level security;
alter table sca_thread_map enable row level security;
alter table sca_digests enable row level security;
```

- [ ] **Step 4: Human — apply the schema**

Paste `db/schema.sql` into the SCA project's SQL editor and run it. Confirm all four tables exist (Table editor).

- [ ] **Step 5: Install the Supabase client and set env**

Run:
```bash
cd "/Users/trentluecke/dev/Claude-Projects/Sales Content Assisnt"
npm install @supabase/supabase-js
```
Add the four new keys to `.env.local` (values pasted by the human), and add them to Vercel:
```bash
vercel env add SCA_SUPABASE_URL preview
vercel env add SCA_SUPABASE_SERVICE_KEY preview
vercel env add RAG_SUPABASE_URL preview
vercel env add RAG_SUPABASE_READONLY_KEY preview
```

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql package.json package-lock.json
git diff --cached --name-only    # confirm all under "Sales Content Assisnt/"
git commit -m "chore(sca): SCA Supabase schema + supabase-js (Phase 1 foundation)"
```

---

### Task 1: Supabase client factories

One place that builds the SCA (read/write) and RAG (read-only) clients from env.

**Files:**
- Create: `lib/supabase.ts`

**Interfaces:**
- Produces: `scaClient(): SupabaseClient` and `ragReadClient(): SupabaseClient`. Every DB task consumes these.

- [ ] **Step 1: Implement the client factories**

Create `lib/supabase.ts`:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Clients are stateless w.r.t. reps; memoizing at module scope is safe and
// avoids rebuilding on warm invocations.
let _sca: SupabaseClient | null = null;
let _rag: SupabaseClient | null = null;

export function scaClient(): SupabaseClient {
  if (!_sca) {
    _sca = createClient(
      process.env.SCA_SUPABASE_URL!,
      process.env.SCA_SUPABASE_SERVICE_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return _sca;
}

export function ragReadClient(): SupabaseClient {
  if (!_rag) {
    _rag = createClient(
      process.env.RAG_SUPABASE_URL!,
      process.env.RAG_SUPABASE_READONLY_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return _rag;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Connectivity is proven in Task 5's integration pass, not here — it needs real secrets.)

- [ ] **Step 3: Commit**

```bash
git add lib/supabase.ts
git commit -m "feat(sca): supabase client factories (SCA + read-only RAG)"
```

---

### Task 2: Anonymization guardrail util

A pure check used wherever generated text is produced, to catch forbidden names leaking into rep-facing copy.

**Files:**
- Create: `lib/guardrail.ts`
- Test: `lib/__tests__/guardrail.test.ts`

**Interfaces:**
- Produces: `containsAny(text: string, names: string[]): string | null` — returns the first name found in `text` (case-insensitive, word-ish match), else `null`. Consumed by `mining` (Task 5) and later the generation lib.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/guardrail.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { containsAny } from "@/lib/guardrail";

describe("containsAny", () => {
  it("finds a forbidden name regardless of case", () => {
    expect(containsAny("Great call with Acme Corp today", ["Acme Corp"])).toBe("Acme Corp");
    expect(containsAny("chatting with gretchen", ["Gretchen"])).toBe("Gretchen");
  });
  it("returns null when no name is present", () => {
    expect(containsAny("a strength coach I spoke with", ["Acme Corp", "Gretchen"])).toBeNull();
  });
  it("does not match a name embedded inside another word", () => {
    expect(containsAny("the according plan", ["Acme"])).toBeNull(); // 'Acme' not in 'according'
  });
  it("ignores empty names", () => {
    expect(containsAny("anything", ["", "  "])).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- guardrail`
Expected: FAIL — `@/lib/guardrail` not found.

- [ ] **Step 3: Implement**

Create `lib/guardrail.ts`:
```ts
// Returns the first forbidden name appearing in `text` (case-insensitive, on
// word boundaries), or null if none. Used to catch customer/prospect/deal
// names leaking into rep-facing copy.
export function containsAny(text: string, names: string[]): string | null {
  const haystack = text.toLowerCase();
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
    if (re.test(haystack)) return raw;
  }
  return null;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- guardrail`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/guardrail.ts lib/__tests__/guardrail.test.ts
git commit -m "feat(sca): anonymization guardrail containsAny() util"
```

---

### Task 3: Ideas pool — pure logic + DB wrappers

Dedup and ranking are pure and unit-tested; the thin DB wrappers are typed here and exercised live in Task 5.

**Files:**
- Create: `lib/ideas.ts`
- Test: `lib/__tests__/ideas.test.ts`

**Interfaces:**
- Produces types `IdeaSource = "demo" | "organic"`, `IdeaStatus = "candidate" | "used" | "rejected"`, and `Idea` (fields below).
- Produces pure: `dedupeIdeas(existingHooks: string[], incoming: Idea[]): Idea[]`, `rankIdeas<T extends {score:number}>(ideas: T[]): T[]`.
- Produces DB: `insertIdeas(ideas: Idea[]): Promise<void>`, `existingHooks(repId: string): Promise<string[]>`, `selectTopCandidates(repId: string, n: number): Promise<Idea[]>`, `setIdeaStatus(ideaId: string, status: IdeaStatus): Promise<void>`. Consumed by the refill/digest/draft-loop plans.

- [ ] **Step 1: Write the failing test (pure logic only)**

Create `lib/__tests__/ideas.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { dedupeIdeas, rankIdeas, type Idea } from "@/lib/ideas";

const mk = (hook: string, score = 0): Idea => ({
  rep_id: "r1", source: "demo", source_ref: {}, hook, rationale: "", score,
});

describe("dedupeIdeas", () => {
  it("drops incoming hooks that already exist (case/space-insensitive)", () => {
    const out = dedupeIdeas(["Go quiet in the demo"], [mk("go   QUIET in the demo"), mk("new angle")]);
    expect(out.map((i) => i.hook)).toEqual(["new angle"]);
  });
  it("drops duplicates within the incoming batch too", () => {
    const out = dedupeIdeas([], [mk("same hook"), mk("Same Hook"), mk("other")]);
    expect(out.map((i) => i.hook)).toEqual(["same hook", "other"]);
  });
});

describe("rankIdeas", () => {
  it("sorts by score descending without mutating input", () => {
    const input = [mk("a", 1), mk("b", 3), mk("c", 2)];
    const out = rankIdeas(input);
    expect(out.map((i) => i.hook)).toEqual(["b", "c", "a"]);
    expect(input.map((i) => i.hook)).toEqual(["a", "b", "c"]); // unmutated
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- ideas`
Expected: FAIL — `@/lib/ideas` not found.

- [ ] **Step 3: Implement**

Create `lib/ideas.ts`:
```ts
import { scaClient } from "@/lib/supabase";

export type IdeaSource = "demo" | "organic";
export type IdeaStatus = "candidate" | "used" | "rejected";

export interface Idea {
  id?: string;
  rep_id: string;
  source: IdeaSource;
  source_ref: Record<string, unknown>;
  hook: string;
  rationale: string;
  score: number;
  status?: IdeaStatus;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function dedupeIdeas(existingHooks: string[], incoming: Idea[]): Idea[] {
  const seen = new Set(existingHooks.map(norm));
  const out: Idea[] = [];
  for (const idea of incoming) {
    const k = norm(idea.hook);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(idea);
  }
  return out;
}

export function rankIdeas<T extends { score: number }>(ideas: T[]): T[] {
  return [...ideas].sort((a, b) => b.score - a.score);
}

export async function existingHooks(repId: string): Promise<string[]> {
  const { data, error } = await scaClient()
    .from("sca_ideas").select("hook").eq("rep_id", repId);
  if (error) throw error;
  return (data ?? []).map((r) => r.hook as string);
}

export async function insertIdeas(ideas: Idea[]): Promise<void> {
  if (ideas.length === 0) return;
  const { error } = await scaClient().from("sca_ideas").insert(
    ideas.map((i) => ({
      rep_id: i.rep_id, source: i.source, source_ref: i.source_ref,
      hook: i.hook, rationale: i.rationale, score: i.score, status: "candidate",
    })),
  );
  if (error) throw error;
}

export async function selectTopCandidates(repId: string, n: number): Promise<Idea[]> {
  const { data, error } = await scaClient()
    .from("sca_ideas").select("*")
    .eq("rep_id", repId).eq("status", "candidate")
    .order("score", { ascending: false }).limit(n);
  if (error) throw error;
  return (data ?? []) as Idea[];
}

export async function setIdeaStatus(ideaId: string, status: IdeaStatus): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === "used") patch.used_at = new Date().toISOString();
  const { error } = await scaClient().from("sca_ideas").update(patch).eq("id", ideaId);
  if (error) throw error;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- ideas`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ideas.ts lib/__tests__/ideas.test.ts
git commit -m "feat(sca): ideas pool — dedupe/rank (pure) + DB wrappers"
```

---

### Task 4: Profiles — types, magic token, CRUD wrappers

**Files:**
- Create: `lib/profiles.ts`
- Test: `lib/__tests__/profiles.test.ts`

**Interfaces:**
- Produces type `Profile` (fields mirror `sca_profiles`).
- Produces pure: `newMagicToken(): string` (URL-safe, unguessable).
- Produces DB: `createDraftProfile(input: {avomaRepName: string; slackUserId: string; displayName?: string}): Promise<Profile>`, `getProfileByToken(token: string): Promise<Profile | null>`, `getProfileBySlackUser(slackUserId: string): Promise<Profile | null>`, `saveProfile(id: string, patch: Partial<Profile>, activate: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing test (pure token only)**

Create `lib/__tests__/profiles.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { newMagicToken } from "@/lib/profiles";

describe("newMagicToken", () => {
  it("is URL-safe and long enough to be unguessable", () => {
    const t = newMagicToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });
  it("is different every call", () => {
    expect(newMagicToken()).not.toBe(newMagicToken());
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- profiles`
Expected: FAIL — `@/lib/profiles` not found.

- [ ] **Step 3: Implement**

Create `lib/profiles.ts`:
```ts
import crypto from "node:crypto";
import { scaClient } from "@/lib/supabase";

export interface Profile {
  id: string;
  avoma_rep_name: string;
  slack_user_id: string;
  magic_token: string;
  display_name: string | null;
  voice_traits: unknown[];
  background: string | null;
  angle: string | null;
  channels: unknown[];
  admired_post: string | null;
  status: "draft" | "active";
}

export function newMagicToken(): string {
  return crypto.randomBytes(24).toString("base64url"); // 32 url-safe chars
}

export async function createDraftProfile(input: {
  avomaRepName: string; slackUserId: string; displayName?: string;
}): Promise<Profile> {
  const { data, error } = await scaClient().from("sca_profiles").insert({
    avoma_rep_name: input.avomaRepName,
    slack_user_id: input.slackUserId,
    display_name: input.displayName ?? null,
    magic_token: newMagicToken(),
    status: "draft",
  }).select("*").single();
  if (error) throw error;
  return data as Profile;
}

export async function getProfileByToken(token: string): Promise<Profile | null> {
  const { data, error } = await scaClient()
    .from("sca_profiles").select("*").eq("magic_token", token).maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function getProfileBySlackUser(slackUserId: string): Promise<Profile | null> {
  const { data, error } = await scaClient()
    .from("sca_profiles").select("*").eq("slack_user_id", slackUserId).maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function saveProfile(
  id: string, patch: Partial<Profile>, activate: boolean,
): Promise<void> {
  const { error } = await scaClient().from("sca_profiles").update({
    ...patch,
    ...(activate ? { status: "active" } : {}),
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- profiles`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/profiles.ts lib/__tests__/profiles.test.ts
git commit -m "feat(sca): profiles — magic token (pure) + CRUD wrappers"
```

---

### Task 5: Mining — read demos, derive voice, mine ideas

The engine. Pure response-shaping is unit-tested; the RAG read + AI calls are verified live in Task 6.

**Files:**
- Create: `lib/mining.ts`
- Test: `lib/__tests__/mining.test.ts`

**Interfaces:**
- Consumes: `ragReadClient` (Task 1), `Idea`/`IdeaSource` (Task 3), `containsAny` (Task 2).
- Produces: `readRepDemos(avomaRepName: string, limit?: number): Promise<DemoTranscript[]>` where `DemoTranscript = { meetingId: string; title: string; date: string; repTurns: string[] }`.
- Produces: `deriveVoiceProfile(demos: DemoTranscript[]): Promise<{ traits: VoiceTrait[]; background: string; angle: string }>` where `VoiceTrait = { name: string; description: string; examples: string[] }`.
- Produces: `mineIdeas(repId: string, demos: DemoTranscript[], profile: {angle: string}): Promise<Idea[]>`.
- Produces pure: `toIdeas(repId: string, raw: RawIdea[]): Idea[]` where `RawIdea = { source: IdeaSource; hook: string; rationale: string; sourceRef: Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test (pure shaper)**

Create `lib/__tests__/mining.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toIdeas } from "@/lib/mining";

describe("toIdeas", () => {
  it("maps raw AI items to Idea rows with rep_id and candidate defaults", () => {
    const out = toIdeas("rep-1", [
      { source: "demo", hook: "Go quiet in the demo", rationale: "contrarian", sourceRef: { meetingId: "m1" } },
      { source: "organic", hook: "Outsider angle", rationale: "fresh", sourceRef: {} },
    ]);
    expect(out).toEqual([
      { rep_id: "rep-1", source: "demo", hook: "Go quiet in the demo", rationale: "contrarian", source_ref: { meetingId: "m1" }, score: 0 },
      { rep_id: "rep-1", source: "organic", hook: "Outsider angle", rationale: "fresh", source_ref: {}, score: 0 },
    ]);
  });
  it("drops items with an empty hook", () => {
    expect(toIdeas("r", [{ source: "demo", hook: "  ", rationale: "x", sourceRef: {} }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- mining`
Expected: FAIL — `@/lib/mining` not found.

- [ ] **Step 3: Implement**

Create `lib/mining.ts`:
```ts
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { ragReadClient } from "@/lib/supabase";
import { containsAny } from "@/lib/guardrail";
import type { Idea, IdeaSource } from "@/lib/ideas";

const MODEL = anthropic("claude-sonnet-5");

export interface DemoTranscript {
  meetingId: string;
  title: string;
  date: string;
  repTurns: string[];
}
export interface VoiceTrait { name: string; description: string; examples: string[] }
export interface RawIdea {
  source: IdeaSource;
  hook: string;
  rationale: string;
  sourceRef: Record<string, unknown>;
}

// Pure: shape raw AI items into Idea rows; drop empty hooks.
export function toIdeas(repId: string, raw: RawIdea[]): Idea[] {
  return raw
    .filter((r) => r.hook.trim().length > 0)
    .map((r) => ({
      rep_id: repId, source: r.source, hook: r.hook, rationale: r.rationale,
      source_ref: r.sourceRef, score: 0,
    }));
}

// Read a rep's demos from the RAG (read-only). Two queries: the rep's demo
// meetings, then those meetings' chunks (proven in Spike C to hold speaker+text).
// Keeps only the rep's own turns (their voice), ordered by chunk_index.
export async function readRepDemos(avomaRepName: string, limit = 8): Promise<DemoTranscript[]> {
  const rag = ragReadClient();
  const { data: meetings, error } = await rag
    .from("meetings")
    .select("id,title,date,rep_name")
    .ilike("rep_name", `*${avomaRepName}*`)   // '*' wildcard, NOT '%' (see RAG list_meetings fix)
    .ilike("call_type", "demo")
    .order("date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (meetings ?? []) as any[];
  if (rows.length === 0) return [];

  const ids = rows.map((m) => m.id);
  const { data: chunks, error: cErr } = await rag
    .from("chunks")
    .select("meeting_id,speaker,text,chunk_index")
    .in("meeting_id", ids)
    .order("chunk_index", { ascending: true });
  if (cErr) throw cErr;
  const allChunks = (chunks ?? []) as any[];

  return rows.map((m) => {
    const first = (m.rep_name ?? avomaRepName).split(/\s+/)[0]?.toLowerCase() ?? "";
    const repTurns = allChunks
      .filter((c) => c.meeting_id === m.id &&
        typeof c.speaker === "string" && c.speaker.toLowerCase().includes(first) &&
        typeof c.text === "string")
      .map((c) => c.text as string)
      .slice(0, 400);
    return { meetingId: m.id, title: m.title ?? "", date: m.date ?? "", repTurns };
  });
}

export async function deriveVoiceProfile(demos: DemoTranscript[]): Promise<{
  traits: VoiceTrait[]; background: string; angle: string;
}> {
  const corpus = demos.map((d) => d.repTurns.join("\n")).join("\n---\n").slice(0, 40_000);
  const { object } = await generateObject({
    model: MODEL,
    schema: z.object({
      traits: z.array(z.object({
        name: z.string(), description: z.string(), examples: z.array(z.string()),
      })).min(3).max(8),
      background: z.string(),
      angle: z.string(),
    }),
    prompt:
      "You are extracting a sales rep's authentic voice from how they actually talk in demos. " +
      "Return 3-8 named voice traits, each with a one-line description and 2-3 verbatim example lines " +
      "from the text. Also infer a short 'background' guess and a 'angle' (their distinctive POV). " +
      "Use only the rep's own words below:\n\n" + corpus,
  });
  return object;
}

export async function mineIdeas(
  repId: string, demos: DemoTranscript[], profile: { angle: string },
): Promise<Idea[]> {
  // Collect real names to forbid from rep-facing text (anonymization guardrail).
  const forbidden = demos.flatMap((d) => namesFromTitle(d.title));
  const corpus = demos
    .map((d) => `# ${d.title} (${d.date})\n${d.repTurns.join("\n")}`)
    .join("\n\n").slice(0, 40_000);

  const { object } = await generateObject({
    model: MODEL,
    schema: z.object({
      ideas: z.array(z.object({
        source: z.enum(["demo", "organic"]),
        hook: z.string(),
        rationale: z.string(),
        meetingId: z.string().optional(),
      })),
    }),
    prompt:
      "Mine LinkedIn/IG content ideas for this rep. Two kinds: 'demo' ideas drawn from a real " +
      "moment in the transcripts, and 'organic' ideas from their angle: " + profile.angle + ". " +
      "HARD RULE: never name a customer, prospect, company, or deal — render every story as an " +
      "anonymized pattern (e.g. 'a strength coach I spoke with'). Each idea: a one-line hook and a " +
      "one-line rationale (why it'd land). For demo ideas include the meetingId.\n\n" + corpus,
  });

  const raw: RawIdea[] = object.ideas.map((i) => ({
    source: i.source,
    hook: i.hook,
    rationale: i.rationale,
    sourceRef: i.meetingId ? { meetingId: i.meetingId } : {},
  }));

  // Guardrail: drop any idea whose rep-facing text leaked a forbidden name.
  const safe = raw.filter((r) => !containsAny(`${r.hook} ${r.rationale}`, forbidden));
  return toIdeas(repId, safe);
}

function namesFromTitle(title: string): string[] {
  // Titles look like "Gretchen Collins and Chris Reynolds" / "Bre / Trent".
  return title.split(/\s+(?:and|&|\/|,)\s+|\s*[/|]\s*/i)
    .map((s) => s.trim()).filter((s) => s.length > 2);
}
```

- [ ] **Step 4: Add the `zod` dependency (used above) and run tests**

Run:
```bash
npm install zod
npm test -- mining
```
Expected: PASS (2 tests). Also run `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/mining.ts lib/__tests__/mining.test.ts package.json package-lock.json
git commit -m "feat(sca): mining — read demos, derive voice, mine anonymized ideas"
```

---

### Task 6: Live integration verification (temporary route)

Prove the real DB + AI + RAG path end-to-end for the guinea pig (Trent), the Phase-0 way: a temporary deployed route (local files can't hold real secrets). Then remove it.

**Files:**
- Create (temporary): `app/api/spike/mine/route.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the temporary verification route**

Create `app/api/spike/mine/route.ts`:
```ts
import { createDraftProfile, getProfileBySlackUser } from "@/lib/profiles";
import { readRepDemos, deriveVoiceProfile, mineIdeas } from "@/lib/mining";
import { existingHooks, dedupeIdeas, insertIdeas, selectTopCandidates } from "@/lib/ideas";

const OWNER_SLACK = "U04ECG6KEA3";
const OWNER_AVOMA = "Trent Luecke";

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("key") !== "minespike") {
    return new Response("forbidden", { status: 403 });
  }
  const out: Record<string, unknown> = {};
  try {
    let profile = await getProfileBySlackUser(OWNER_SLACK);
    if (!profile) profile = await createDraftProfile({ avomaRepName: OWNER_AVOMA, slackUserId: OWNER_SLACK, displayName: "Trent" });
    out.profileId = profile.id;

    const demos = await readRepDemos(OWNER_AVOMA, 6);
    out.demoCount = demos.length;
    out.repTurnSample = demos[0]?.repTurns.slice(0, 2);

    const voice = await deriveVoiceProfile(demos);
    out.traitNames = voice.traits.map((t) => t.name);

    const mined = await mineIdeas(profile.id, demos, { angle: voice.angle });
    const fresh = dedupeIdeas(await existingHooks(profile.id), mined);
    await insertIdeas(fresh);
    out.minedCount = mined.length;
    out.insertedCount = fresh.length;

    const top = await selectTopCandidates(profile.id, 3);
    out.top3 = top.map((i) => ({ source: i.source, hook: i.hook }));
  } catch (e: any) {
    out.error = e?.message ?? String(e);
  }
  return Response.json(out);
}
```

- [ ] **Step 2: Deploy and run**

Run:
```bash
npm run build && vercel deploy
```
Then hit `https://<preview-url>/api/spike/mine?key=minespike`.
Expected JSON shows: `demoCount` > 0, `traitNames` (3-8 named traits), `minedCount` > 0, `insertedCount` > 0, and a `top3` array of anonymized hooks. Record it in the findings doc.

- [ ] **Step 3: Manually verify the guardrail held**

Read `top3` and `repTurnSample`. Confirm no customer/prospect names appear in any hook. Spot-check the SCA Supabase `sca_ideas` table has the inserted rows for the profile. If a name leaked, harden `namesFromTitle`/the prompt and redeploy before proceeding.

- [ ] **Step 4: Remove the temporary route and redeploy**

Run:
```bash
rm -rf app/api/spike
npm run build && vercel deploy
```
Confirm `GET /api/spike/mine` now returns 404.

- [ ] **Step 5: Commit**

```bash
git add -A
git diff --cached --name-only   # confirm all under "Sales Content Assisnt/"
git commit -m "chore(sca): verify mining engine live (temp route added + removed)"
```

---

## Plan 1 Exit Criteria

- Schema live in the SCA Supabase project; read-only RAG path works.
- `lib/supabase`, `lib/guardrail`, `lib/ideas`, `lib/profiles`, `lib/mining` implemented; all unit tests green; `tsc --noEmit` clean.
- Live pass proved: Trent's demos → draft voice profile → anonymized idea pool → top-3 selectable, with the guardrail holding.

**Next:** Plan 2 (Onboarding) consumes `getProfileByToken`, `saveProfile`, `readRepDemos`, `deriveVoiceProfile`. It is written after Plan 1 lands, so its tasks reference the real signatures above.
