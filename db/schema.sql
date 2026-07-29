-- SCA (Sales Content Assistant) schema. Applied to the dedicated SCA Supabase project
-- (NOT the Avoma RAG project). Run once in the SCA project's SQL editor.
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
