-- Order costing tables: production cost reference + saved quotes
-- Run after 001_initial_schema.sql

-- =============================================================
-- TABLES
-- =============================================================

create table if not exists public.budget_production_costs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  description text not null,
  cost_low numeric(10,2) not null default 0,
  cost_high numeric(10,2) not null default 0,
  pot_name text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.budget_order_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_name text,
  order_reference text,
  notes text,
  pieces jsonb not null default '[]'::jsonb,
  production_subtotal numeric(10,2) not null default 0,
  suggested_retail numeric(10,2),
  margin_multiplier numeric(5,2) not null default 4,
  status text not null default 'draft',
  committed_to_pots boolean not null default false,
  created_at timestamptz not null default now()
);

-- =============================================================
-- INDEXES
-- =============================================================

create index if not exists idx_production_costs_user on public.budget_production_costs(user_id, sort_order);
create index if not exists idx_order_quotes_user on public.budget_order_quotes(user_id, created_at desc);

-- =============================================================
-- RLS
-- =============================================================

alter table public.budget_production_costs enable row level security;
alter table public.budget_order_quotes enable row level security;

drop policy if exists "production_costs_select_own" on public.budget_production_costs;
create policy "production_costs_select_own" on public.budget_production_costs
  for select using (auth.uid() = user_id);

drop policy if exists "production_costs_insert_own" on public.budget_production_costs;
create policy "production_costs_insert_own" on public.budget_production_costs
  for insert with check (auth.uid() = user_id);

drop policy if exists "production_costs_update_own" on public.budget_production_costs;
create policy "production_costs_update_own" on public.budget_production_costs
  for update using (auth.uid() = user_id);

drop policy if exists "production_costs_delete_own" on public.budget_production_costs;
create policy "production_costs_delete_own" on public.budget_production_costs
  for delete using (auth.uid() = user_id);

drop policy if exists "order_quotes_select_own" on public.budget_order_quotes;
create policy "order_quotes_select_own" on public.budget_order_quotes
  for select using (auth.uid() = user_id);

drop policy if exists "order_quotes_insert_own" on public.budget_order_quotes;
create policy "order_quotes_insert_own" on public.budget_order_quotes
  for insert with check (auth.uid() = user_id);

drop policy if exists "order_quotes_update_own" on public.budget_order_quotes;
create policy "order_quotes_update_own" on public.budget_order_quotes
  for update using (auth.uid() = user_id);

drop policy if exists "order_quotes_delete_own" on public.budget_order_quotes;
create policy "order_quotes_delete_own" on public.budget_order_quotes
  for delete using (auth.uid() = user_id);

-- =============================================================
-- NO RATE CARD IS SEEDED HERE, DELIBERATELY
-- =============================================================
-- budget_production_costs is created empty and stays empty until
-- someone puts their own rates in it. The categories on a rate card
-- are the names a practice uses for its own work, so shipping a set
-- would mean every install inherited one practice's vocabulary and
-- then had to argue with it.
--
-- Three ways to start a card, none of them automatic:
--
--   1. Build categories directly in the app. They are renameable at
--      any time, and renaming moves every rate inside them.
--   2. Apply a rate block (migration 006), if you have one saved or
--      have been given one.
--   3. Adapt an example. supabase/examples/ holds one working
--      practice's card as a starting point. It is not run by any
--      migration and has to be pasted deliberately.
