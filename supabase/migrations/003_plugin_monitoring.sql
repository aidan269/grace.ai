-- Grace V2.1: plugin inactivity nudges and monitoring

create table if not exists public.plugin_nudges (
  id uuid primary key default gen_random_uuid(),
  slug text,
  source_url text,
  step text,
  reason text not null default 'inactivity',
  created_at timestamptz not null default now()
);

create index if not exists plugin_nudges_created_at_idx on public.plugin_nudges (created_at desc);
create index if not exists plugin_nudges_slug_idx on public.plugin_nudges (slug);

alter table public.plugin_nudges enable row level security;
