-- Grace intelligence store (run in Supabase SQL editor or via CLI)
-- Requires: extension pgcrypto for gen_random_uuid (enabled by default on Supabase)

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  title text not null,
  source text,
  body_snippet text,
  raw_item jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.triage_runs (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id) on delete cascade,
  viral_score smallint not null check (viral_score between 0 and 4),
  status text,
  slug text,
  why text,
  q1 text,
  q2 text,
  raw_assess text,
  issue_url text,
  issue_error text,
  pipeline text not null default 'news-sync',
  created_at timestamptz not null default now()
);

create index if not exists triage_runs_story_id_idx on public.triage_runs (story_id);
create index if not exists triage_runs_created_at_idx on public.triage_runs (created_at desc);
create index if not exists stories_updated_at_idx on public.stories (updated_at desc);

-- RLS on with no policies: only the service_role key (Vercel) can read/write; anon is denied.
alter table public.stories enable row level security;
alter table public.triage_runs enable row level security;
