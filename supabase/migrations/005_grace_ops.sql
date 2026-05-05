-- Grace Ops v1: AEO/GEO weekly operating system for in-house teams

create table if not exists public.grace_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table if not exists public.grace_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.grace_workspaces (id) on delete cascade,
  snapshot_date date not null,
  north_star_score numeric(6,2) not null default 0,
  answer_inclusion_rate numeric(6,2) not null default 0,
  entity_coverage_score numeric(6,2) not null default 0,
  citation_frequency numeric(6,2) not null default 0,
  local_profile_completeness numeric(6,2) not null default 0,
  content_freshness_ratio numeric(6,2) not null default 0,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, snapshot_date)
);

create table if not exists public.grace_content_nodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.grace_workspaces (id) on delete cascade,
  node_type text not null check (node_type in ('website_page', 'landing_page', 'blog_page', 'gbp_profile', 'competitor_page', 'analytics_snapshot')),
  url text,
  title text,
  topic_cluster text,
  entity_tags text[] not null default '{}',
  location_tag text,
  source_system text not null,
  content_text text,
  metadata jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now()
);

create index if not exists grace_content_nodes_workspace_idx on public.grace_content_nodes (workspace_id, ingested_at desc);
create index if not exists grace_content_nodes_node_type_idx on public.grace_content_nodes (node_type);

create table if not exists public.grace_scores (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.grace_workspaces (id) on delete cascade,
  content_node_id uuid references public.grace_content_nodes (id) on delete cascade,
  score_scope text not null check (score_scope in ('page', 'cluster', 'workspace')),
  answerability_score numeric(6,2) not null default 0,
  entity_authority_score numeric(6,2) not null default 0,
  geo_readiness_score numeric(6,2) not null default 0,
  competitive_gap_score numeric(6,2) not null default 0,
  overall_score numeric(6,2) not null default 0,
  model_consensus jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  run_id text,
  created_at timestamptz not null default now()
);

create index if not exists grace_scores_workspace_idx on public.grace_scores (workspace_id, created_at desc);
create index if not exists grace_scores_run_id_idx on public.grace_scores (run_id);

create table if not exists public.grace_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.grace_workspaces (id) on delete cascade,
  score_id uuid references public.grace_scores (id) on delete set null,
  recommendation_type text not null check (recommendation_type in ('create_topic', 'refresh_page', 'add_schema_faq', 'improve_internal_links', 'update_gbp')),
  title text not null,
  details text not null,
  expected_impact numeric(6,2) not null default 0,
  confidence_score numeric(6,2) not null default 0,
  effort_score numeric(6,2) not null default 0,
  priority_score numeric(6,2) not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'executed', 'measured', 'deferred')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grace_recommendations_workspace_idx on public.grace_recommendations (workspace_id, created_at desc);
create index if not exists grace_recommendations_status_idx on public.grace_recommendations (status, priority_score desc);

create table if not exists public.grace_weekly_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.grace_workspaces (id) on delete cascade,
  run_id text not null unique,
  status text not null check (status in ('started', 'completed', 'failed')),
  run_detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.grace_approval_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.grace_workspaces (id) on delete cascade,
  recommendation_id uuid not null references public.grace_recommendations (id) on delete cascade,
  previous_status text not null,
  next_status text not null,
  actor text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists grace_approval_actions_rec_idx on public.grace_approval_actions (recommendation_id, created_at desc);

alter table public.grace_workspaces enable row level security;
alter table public.grace_metric_snapshots enable row level security;
alter table public.grace_content_nodes enable row level security;
alter table public.grace_scores enable row level security;
alter table public.grace_recommendations enable row level security;
alter table public.grace_weekly_runs enable row level security;
alter table public.grace_approval_actions enable row level security;
