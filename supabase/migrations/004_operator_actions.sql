-- Grace V2.2: operator workflow actions (observe -> decide -> act)

create table if not exists public.operator_actions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id) on delete cascade,
  action text not null check (action in ('assign', 'needs_research', 'ship', 'defer')),
  note text,
  actor text,
  assignee text,
  created_at timestamptz not null default now()
);

create index if not exists operator_actions_story_id_idx on public.operator_actions (story_id);
create index if not exists operator_actions_created_at_idx on public.operator_actions (created_at desc);

alter table public.operator_actions enable row level security;
