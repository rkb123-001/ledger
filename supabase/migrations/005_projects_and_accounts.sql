-- =============================================================
-- Ledger 005: multi-account tracking and project budgeting
-- Run after 004_enable_realtime.sql
--
-- This migration is ADDITIVE ONLY. It creates new tables, adds
-- nullable columns to existing ones, and backfills. It does not
-- drop or alter any existing column, and it does not delete data.
-- budget_accounts is left in place and still works; the new
-- budget_bank_accounts table supersedes it going forward.
--
-- Safe to run more than once.
-- =============================================================


-- =============================================================
-- 1. BANK ACCOUNTS  (arbitrary rows, replacing three fixed columns)
-- =============================================================
-- budget_accounts held one row per user with hsbc_balance,
-- monzo_main_balance and incoming_amount as hardcoded columns,
-- which made "add another account" a schema change. This models
-- an account as a row.

create table if not exists public.budget_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  institution text,
  kind text not null default 'current',
  balance numeric(12,2) not null default 0,
  currency text not null default 'GBP',
  expected_date date,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_bank_accounts_kind_check
    check (kind in ('current', 'savings', 'incoming', 'credit', 'cash'))
);

comment on table public.budget_bank_accounts is
  'One row per real account. Supersedes the fixed columns on budget_accounts.';
comment on column public.budget_bank_accounts.kind is
  'incoming = money owed but not yet received; kept separate so it never inflates available balance.';


-- =============================================================
-- 2. PROJECTS
-- =============================================================

create table if not exists public.budget_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  client_name text,
  reference text,
  status text not null default 'active',
  budget_amount numeric(12,2),
  target_margin numeric(5,2) not null default 4,
  start_date date,
  target_date date,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_projects_status_check
    check (status in ('quoted', 'active', 'complete', 'archived'))
);

comment on column public.budget_projects.budget_amount is
  'Planned spend ceiling. Null means the project is tracked but not capped.';
comment on column public.budget_projects.target_margin is
  'Retail multiplier applied to predicted production cost for this project.';


-- =============================================================
-- 3. LINK EXISTING RECORDS TO PROJECTS  (all nullable, non-breaking)
-- =============================================================
-- Every existing row keeps project_id null and behaves exactly as
-- before. Unassigned spend stays visible rather than disappearing
-- into a default project.

alter table public.budget_items
  add column if not exists project_id uuid references public.budget_projects(id) on delete set null;

alter table public.budget_order_quotes
  add column if not exists project_id uuid references public.budget_projects(id) on delete set null;

alter table public.budget_drafts
  add column if not exists suggested_project_id uuid references public.budget_projects(id) on delete set null;

-- Actual outturn, recorded when a project closes. Null until then.
-- This is what the prediction calibration learns from.
alter table public.budget_order_quotes
  add column if not exists actual_production_cost numeric(12,2);


-- =============================================================
-- 4. INDEXES
-- =============================================================

create index if not exists idx_bank_accounts_user
  on public.budget_bank_accounts(user_id, sort_order);
create index if not exists idx_projects_user
  on public.budget_projects(user_id, status, sort_order);
create index if not exists idx_items_project
  on public.budget_items(project_id) where project_id is not null;
create index if not exists idx_order_quotes_project
  on public.budget_order_quotes(project_id) where project_id is not null;


-- =============================================================
-- 5. ROW LEVEL SECURITY
-- =============================================================

alter table public.budget_bank_accounts enable row level security;
alter table public.budget_projects enable row level security;

drop policy if exists "bank_accounts_select_own" on public.budget_bank_accounts;
create policy "bank_accounts_select_own" on public.budget_bank_accounts
  for select using (auth.uid() = user_id);

drop policy if exists "bank_accounts_insert_own" on public.budget_bank_accounts;
create policy "bank_accounts_insert_own" on public.budget_bank_accounts
  for insert with check (auth.uid() = user_id);

drop policy if exists "bank_accounts_update_own" on public.budget_bank_accounts;
create policy "bank_accounts_update_own" on public.budget_bank_accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "bank_accounts_delete_own" on public.budget_bank_accounts;
create policy "bank_accounts_delete_own" on public.budget_bank_accounts
  for delete using (auth.uid() = user_id);

drop policy if exists "projects_select_own" on public.budget_projects;
create policy "projects_select_own" on public.budget_projects
  for select using (auth.uid() = user_id);

drop policy if exists "projects_insert_own" on public.budget_projects;
create policy "projects_insert_own" on public.budget_projects
  for insert with check (auth.uid() = user_id);

drop policy if exists "projects_update_own" on public.budget_projects;
create policy "projects_update_own" on public.budget_projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "projects_delete_own" on public.budget_projects;
create policy "projects_delete_own" on public.budget_projects
  for delete using (auth.uid() = user_id);


-- =============================================================
-- 6. BACKFILL BANK ACCOUNTS FROM THE OLD FIXED COLUMNS
-- =============================================================
-- Guarded: only runs for users who have no bank account rows yet,
-- so re-running this migration cannot duplicate accounts.

do $$
declare
  r record;
begin
  for r in
    select a.user_id, a.hsbc_balance, a.monzo_main_balance,
           a.incoming_amount, a.incoming_date
    from public.budget_accounts a
    where not exists (
      select 1 from public.budget_bank_accounts b where b.user_id = a.user_id
    )
  loop
    insert into public.budget_bank_accounts
      (user_id, name, institution, kind, balance, sort_order)
    values
      (r.user_id, 'HSBC',       'HSBC',  'current', coalesce(r.hsbc_balance, 0),       1),
      (r.user_id, 'Monzo main', 'Monzo', 'current', coalesce(r.monzo_main_balance, 0), 2);

    if coalesce(r.incoming_amount, 0) <> 0 then
      insert into public.budget_bank_accounts
        (user_id, name, kind, balance, expected_date, sort_order)
      values
        (r.user_id, 'Incoming payment', 'incoming', r.incoming_amount,
         case
           when r.incoming_date ~ '^\d{4}-\d{2}-\d{2}$' then r.incoming_date::date
           else null
         end,
         3);
    end if;
  end loop;
end $$;


-- =============================================================
-- 7. PROJECT ROLLUP VIEW
-- =============================================================
-- Predicted vs committed vs actually paid, per project.
-- security_invoker means the view is filtered by the querying
-- user's RLS policies rather than the view owner's.

create or replace view public.budget_project_rollup as
select
  p.id                as project_id,
  p.user_id,
  p.name,
  p.client_name,
  p.status,
  p.budget_amount,
  p.target_margin,
  p.target_date,

  -- everything allocated to this project
  coalesce(i.committed_total, 0)  as committed_total,
  -- of that, what has actually left the account
  coalesce(i.paid_total, 0)       as paid_total,
  -- of that, what is still a guess rather than a known figure
  coalesce(i.estimated_total, 0)  as estimated_total,
  coalesce(i.item_count, 0)       as item_count,

  -- what the costing engine predicted across this project's quotes
  coalesce(q.quoted_production, 0) as quoted_production,
  coalesce(q.quoted_retail, 0)     as quoted_retail,
  coalesce(q.quote_count, 0)       as quote_count,

  -- headroom against the planned ceiling
  case
    when p.budget_amount is null then null
    else p.budget_amount - coalesce(i.committed_total, 0)
  end as remaining_budget,

  -- variance against what was quoted, positive means over
  coalesce(i.committed_total, 0) - coalesce(q.quoted_production, 0)
    as variance_vs_quote

from public.budget_projects p

left join (
  select
    project_id,
    sum(amount)                                          as committed_total,
    sum(amount) filter (where paid)                      as paid_total,
    sum(amount) filter (where is_estimate)               as estimated_total,
    count(*)                                             as item_count
  from public.budget_items
  where project_id is not null
  group by project_id
) i on i.project_id = p.id

left join (
  select
    project_id,
    sum(production_subtotal)                             as quoted_production,
    sum(coalesce(suggested_retail, 0))                   as quoted_retail,
    count(*)                                             as quote_count
  from public.budget_order_quotes
  where project_id is not null
  group by project_id
) q on q.project_id = p.id;

alter view public.budget_project_rollup set (security_invoker = on);


-- =============================================================
-- 8. PREDICTION CALIBRATION
-- =============================================================
-- Quotes are built from cost_low/cost_high ranges on the rate card.
-- Those ranges are estimates, and estimates drift in a consistent
-- direction for a given maker. This function measures that drift.
--
-- Returns the ratio of actual production cost to quoted production
-- cost across closed quotes. Above 1 means work has historically
-- cost more than quoted, so new quotes should be scaled up.
--
-- Returns 1 when there is not enough history to say anything,
-- which is the honest default rather than a flattering one.

create or replace function public.budget_prediction_factor(p_user_id uuid)
returns numeric
language sql
stable
security invoker
as $$
  with closed as (
    select
      actual_production_cost / nullif(production_subtotal, 0) as ratio
    from public.budget_order_quotes
    where user_id = p_user_id
      and actual_production_cost is not null
      and production_subtotal > 0
  ),
  bounded as (
    -- discard implausible outliers so one mis-keyed figure cannot
    -- skew every future quote
    select ratio from closed where ratio between 0.25 and 4.0
  )
  select case
    when (select count(*) from bounded) < 3 then 1.0
    else round(
      (select percentile_cont(0.5) within group (order by ratio) from bounded)::numeric,
      3)
  end;
$$;

comment on function public.budget_prediction_factor(uuid) is
  'Median actual/quoted ratio over closed quotes. 1.0 until at least 3 closed quotes exist.';


-- =============================================================
-- 9. KEEP updated_at HONEST
-- =============================================================

create or replace function public.budget_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_bank_accounts_touch on public.budget_bank_accounts;
create trigger trg_bank_accounts_touch
  before update on public.budget_bank_accounts
  for each row execute function public.budget_touch_updated_at();

drop trigger if exists trg_projects_touch on public.budget_projects;
create trigger trg_projects_touch
  before update on public.budget_projects
  for each row execute function public.budget_touch_updated_at();


-- =============================================================
-- 10. REALTIME
-- =============================================================
-- 004 added the original tables to the realtime publication so two
-- open windows stay in sync. The new tables need the same treatment.
-- Wrapped because adding a table that is already in the publication
-- raises, and this migration must stay safe to re-run.

do $$
begin
  begin
    alter publication supabase_realtime add table public.budget_bank_accounts;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.budget_projects;
  exception when duplicate_object then null;
  end;
end $$;
