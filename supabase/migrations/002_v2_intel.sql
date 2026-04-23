-- Grace V2: reliability, similarity, and governance artifacts

alter table if exists public.stories
  add column if not exists run_id text;

alter table if exists public.triage_runs
  add column if not exists run_id text;

create index if not exists stories_run_id_idx on public.stories (run_id);
create index if not exists triage_runs_run_id_idx on public.triage_runs (run_id);

create table if not exists public.story_related (
  story_id uuid not null references public.stories (id) on delete cascade,
  related_story_id uuid not null references public.stories (id) on delete cascade,
  score numeric(5,4) not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (story_id, related_story_id)
);

create index if not exists story_related_story_id_idx on public.story_related (story_id);
create index if not exists story_related_related_story_id_idx on public.story_related (related_story_id);

create table if not exists public.run_audit (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  pipeline text not null,
  status text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists run_audit_run_id_idx on public.run_audit (run_id);
create index if not exists run_audit_created_at_idx on public.run_audit (created_at desc);

create table if not exists public.publish_decisions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id) on delete cascade,
  decision text not null check (decision in ('reviewed', 'approved', 'deferred')),
  note text,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists publish_decisions_story_id_idx on public.publish_decisions (story_id);
create index if not exists publish_decisions_created_at_idx on public.publish_decisions (created_at desc);

create table if not exists public.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version text not null,
  prompt_text text not null,
  created_at timestamptz not null default now(),
  unique (name, version)
);

alter table public.story_related enable row level security;
alter table public.run_audit enable row level security;
alter table public.publish_decisions enable row level security;
alter table public.prompt_versions enable row level security;
