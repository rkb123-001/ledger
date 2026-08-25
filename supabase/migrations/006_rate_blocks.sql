-- =============================================================
-- Ledger 006: rate blocks
-- Run after 005_projects_and_accounts.sql
--
-- A rate block is a named, reusable set of rate card lines: the
-- costs of one kind of work, saved so they can be laid down again
-- on a new card without being retyped.
--
-- This migration deliberately ships NO blocks. The application does
-- not get to decide what kind of practice you have. A block exists
-- only because a user built a category on their own rate card and
-- chose to keep it, which means the starting content of this table
-- is always theirs rather than an example inherited from whoever
-- wrote the software.
--
-- ADDITIVE ONLY. Creates one table. Alters nothing, drops nothing.
-- Safe to run more than once.
-- =============================================================


-- =============================================================
-- 1. THE TABLE
-- =============================================================
-- lines is jsonb rather than a child table because a block is a
-- recipe, not live data. Nothing joins to an individual line, the
-- whole block is always read and written together, and a block must
-- keep working after the rate card rows it came from are edited or
-- deleted. Normalising it would buy referential integrity against a
-- reference nothing needs to follow.

create table if not exists public.budget_rate_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  lines jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_rate_blocks_lines_is_array
    check (jsonb_typeof(lines) = 'array')
);

comment on table public.budget_rate_blocks is
  'Reusable sets of rate card lines. Ships empty by design: every block is one a user chose to keep.';
comment on column public.budget_rate_blocks.lines is
  'Array of {description, cost_low, cost_high, pot_name, notes, category}. A null category means the line takes the block name when applied.';
comment on column public.budget_rate_blocks.name is
  'Also the fallback category for any line that carries none of its own.';


-- =============================================================
-- 2. INDEX
-- =============================================================

create index if not exists idx_rate_blocks_user
  on public.budget_rate_blocks(user_id, sort_order);


-- =============================================================
-- 3. ROW LEVEL SECURITY
-- =============================================================

alter table public.budget_rate_blocks enable row level security;

drop policy if exists "rate_blocks_select_own" on public.budget_rate_blocks;
create policy "rate_blocks_select_own" on public.budget_rate_blocks
  for select using (auth.uid() = user_id);

drop policy if exists "rate_blocks_insert_own" on public.budget_rate_blocks;
create policy "rate_blocks_insert_own" on public.budget_rate_blocks
  for insert with check (auth.uid() = user_id);

drop policy if exists "rate_blocks_update_own" on public.budget_rate_blocks;
create policy "rate_blocks_update_own" on public.budget_rate_blocks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "rate_blocks_delete_own" on public.budget_rate_blocks;
create policy "rate_blocks_delete_own" on public.budget_rate_blocks
  for delete using (auth.uid() = user_id);


-- =============================================================
-- 4. KEEP updated_at HONEST
-- =============================================================
-- budget_touch_updated_at() was created in 005.

drop trigger if exists trg_rate_blocks_touch on public.budget_rate_blocks;
create trigger trg_rate_blocks_touch
  before update on public.budget_rate_blocks
  for each row execute function public.budget_touch_updated_at();


-- =============================================================
-- 5. REALTIME
-- =============================================================
-- Wrapped because adding a table already in the publication raises,
-- and this migration must stay safe to re-run.

do $$
begin
  begin
    alter publication supabase_realtime add table public.budget_rate_blocks;
  exception when duplicate_object then null;
  end;
end $$;
