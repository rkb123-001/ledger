-- Studio Budget initial schema
-- Run this in your Supabase SQL Editor

-- =============================================================
-- TABLES
-- =============================================================

create table if not exists public.budget_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  hsbc_balance numeric(10,2) not null default 0,
  monzo_main_balance numeric(10,2) not null default 0,
  incoming_amount numeric(10,2) not null default 0,
  incoming_date text default '',
  scenario text not null default 'with',
  updated_at timestamptz not null default now(),
  unique(user_id)
);

create table if not exists public.budget_pots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  current_balance numeric(10,2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.budget_items (
  id uuid primary key default gen_random_uuid(),
  pot_id uuid not null references public.budget_pots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  amount numeric(10,2) not null default 0,
  paid boolean not null default false,
  is_estimate boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.budget_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  suggested_pot_id uuid references public.budget_pots(id) on delete set null,
  suggested_pot_name text,
  label text not null,
  amount numeric(10,2) not null default 0,
  is_estimate boolean not null default false,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- =============================================================
-- INDEXES
-- =============================================================

create index if not exists idx_budget_pots_user on public.budget_pots(user_id, sort_order);
create index if not exists idx_budget_items_pot on public.budget_items(pot_id, sort_order);
create index if not exists idx_budget_items_user on public.budget_items(user_id);
create index if not exists idx_budget_drafts_user on public.budget_drafts(user_id, status);

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

alter table public.budget_accounts enable row level security;
alter table public.budget_pots enable row level security;
alter table public.budget_items enable row level security;
alter table public.budget_drafts enable row level security;

-- accounts policies
drop policy if exists "accounts_select_own" on public.budget_accounts;
create policy "accounts_select_own" on public.budget_accounts
  for select using (auth.uid() = user_id);

drop policy if exists "accounts_insert_own" on public.budget_accounts;
create policy "accounts_insert_own" on public.budget_accounts
  for insert with check (auth.uid() = user_id);

drop policy if exists "accounts_update_own" on public.budget_accounts;
create policy "accounts_update_own" on public.budget_accounts
  for update using (auth.uid() = user_id);

-- pots policies
drop policy if exists "pots_select_own" on public.budget_pots;
create policy "pots_select_own" on public.budget_pots
  for select using (auth.uid() = user_id);

drop policy if exists "pots_insert_own" on public.budget_pots;
create policy "pots_insert_own" on public.budget_pots
  for insert with check (auth.uid() = user_id);

drop policy if exists "pots_update_own" on public.budget_pots;
create policy "pots_update_own" on public.budget_pots
  for update using (auth.uid() = user_id);

drop policy if exists "pots_delete_own" on public.budget_pots;
create policy "pots_delete_own" on public.budget_pots
  for delete using (auth.uid() = user_id);

-- items policies
drop policy if exists "items_select_own" on public.budget_items;
create policy "items_select_own" on public.budget_items
  for select using (auth.uid() = user_id);

drop policy if exists "items_insert_own" on public.budget_items;
create policy "items_insert_own" on public.budget_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "items_update_own" on public.budget_items;
create policy "items_update_own" on public.budget_items
  for update using (auth.uid() = user_id);

drop policy if exists "items_delete_own" on public.budget_items;
create policy "items_delete_own" on public.budget_items
  for delete using (auth.uid() = user_id);

-- drafts policies
drop policy if exists "drafts_select_own" on public.budget_drafts;
create policy "drafts_select_own" on public.budget_drafts
  for select using (auth.uid() = user_id);

drop policy if exists "drafts_insert_own" on public.budget_drafts;
create policy "drafts_insert_own" on public.budget_drafts
  for insert with check (auth.uid() = user_id);

drop policy if exists "drafts_update_own" on public.budget_drafts;
create policy "drafts_update_own" on public.budget_drafts
  for update using (auth.uid() = user_id);

drop policy if exists "drafts_delete_own" on public.budget_drafts;
create policy "drafts_delete_own" on public.budget_drafts
  for delete using (auth.uid() = user_id);
