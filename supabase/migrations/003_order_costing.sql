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
-- SEED DEFAULT PRODUCTION COSTS
-- =============================================================
-- Replace YOUR_USER_ID_HERE with your auth.users.id, then run.
-- Skip this block if you'd rather start with an empty rate card.

do $$
declare
  v_user_id uuid := 'YOUR_USER_ID_HERE'::uuid;
begin
  -- Casting
  insert into public.budget_production_costs (user_id, category, description, cost_low, cost_high, pot_name, sort_order) values
    (v_user_id, 'Casting', 'Silver pendant casting (small/medium)', 35, 40, 'Casters', 1),
    (v_user_id, 'Casting', 'Silver ring casting', 25, 35, 'Casters', 2),
    (v_user_id, 'Casting', 'Silver earring casting (per pair)', 30, 40, 'Casters', 3),
    (v_user_id, 'Casting', 'Silver brooch/pin casting', 30, 35, 'Casters', 4),
    (v_user_id, 'Casting', 'Silver locket casting (large)', 40, 60, 'Casters', 5),
    (v_user_id, 'Casting', '9ct white gold casting (small piece)', 150, 250, 'Casters', 6),
    (v_user_id, 'Casting', '9ct white gold casting (large piece)', 400, 700, 'Casters', 7);

  -- Hallmarking
  insert into public.budget_production_costs (user_id, category, description, cost_low, cost_high, pot_name, sort_order) values
    (v_user_id, 'Hallmarking', 'Silver hallmark (standard)', 10, 10, 'Hallmarking', 8),
    (v_user_id, 'Hallmarking', 'Gold hallmark (standard)', 30, 40, 'Hallmarking', 9),
    (v_user_id, 'Hallmarking', 'Gold hallmark (next day)', 60, 60, 'Hallmarking', 10);

  -- Plating
  insert into public.budget_production_costs (user_id, category, description, cost_low, cost_high, pot_name, sort_order) values
    (v_user_id, 'Plating', 'Gold vermeil plating (small piece)', 40, 50, 'Plating', 11),
    (v_user_id, 'Plating', 'Gold vermeil plating (medium piece)', 50, 70, 'Plating', 12),
    (v_user_id, 'Plating', 'Silver plating', 25, 30, 'Plating', 13),
    (v_user_id, 'Plating', 'Gold plating (Thursday Child style)', 50, 50, 'Plating', 14);

  -- Materials
  insert into public.budget_production_costs (user_id, category, description, cost_low, cost_high, pot_name, sort_order) values
    (v_user_id, 'Materials', 'Delicate silver chain (per piece)', 8, 12, 'Hatton Garden materials', 15),
    (v_user_id, 'Materials', 'Silver belcher chain thick (46cm)', 75, 80, 'Hatton Garden materials', 16),
    (v_user_id, 'Materials', 'Silver box chain delicate', 8, 12, 'Hatton Garden materials', 17),
    (v_user_id, 'Materials', 'Gold rolled chain', 12, 18, 'Hatton Garden materials', 18),
    (v_user_id, 'Materials', 'Silver findings/components (small)', 2, 6, 'Hatton Garden materials', 19),
    (v_user_id, 'Materials', 'Presentation packaging', 10, 15, 'Hatton Garden materials', 20);

  -- Labour / overheads (notional, applied as flat add-on)
  insert into public.budget_production_costs (user_id, category, description, cost_low, cost_high, pot_name, notes, sort_order) values
    (v_user_id, 'Labour', 'Studio time per piece (hand-finishing)', 20, 40, null, 'Add per piece, varies with complexity', 21),
    (v_user_id, 'Labour', 'Hand-engraving (small)', 30, 60, null, 'For engraved lockets, plates', 22);

  -- Margin defaults
  insert into public.budget_production_costs (user_id, category, description, cost_low, cost_high, pot_name, notes, sort_order) values
    (v_user_id, 'Margin', 'Standard retail multiplier', 4, 4, null, '4x production cost is standard for jewellery wholesale-to-retail', 23),
    (v_user_id, 'Margin', 'Direct-to-consumer multiplier', 5, 6, null, 'For DTC pieces with full retail margin', 24);
end $$;
