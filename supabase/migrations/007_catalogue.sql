-- Catalogue of listed products, synced from Shopify.
--
-- Why this exists: cost-order priced every enquiry from first principles, which
-- is right for a bespoke commission and wrong for a piece that already has a
-- price on the website. For a listed piece the question is not "what should
-- this cost" but "does the price I already publish still work".
--
-- Additive and safe to run more than once.

create table if not exists public.budget_catalogue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  shopify_product_id text,
  shopify_variant_id text,
  title text not null,
  variant_title text,
  price numeric(10,2) not null default 0,
  currency text not null default 'GBP',
  handle text,
  status text not null default 'active',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.budget_catalogue is
  'One row per sellable variant. Synced from Shopify by the sync-catalogue function.';

-- One row per variant per user, so a re-sync updates rather than duplicates.
--
-- This has to be a constraint rather than a partial unique index. Postgres will
-- not use a partial index for ON CONFLICT unless the query restates the same
-- predicate, and PostgREST cannot express that, so an upsert against a partial
-- index fails with "no unique or exclusion constraint matching the ON CONFLICT
-- specification". Multiple NULLs are still permitted here, since Postgres
-- treats NULLs as distinct for uniqueness.
alter table public.budget_catalogue
  drop constraint if exists budget_catalogue_variant_key;

alter table public.budget_catalogue
  add constraint budget_catalogue_variant_key
  unique (user_id, shopify_variant_id);

create index if not exists idx_budget_catalogue_user
  on public.budget_catalogue(user_id, title);

alter table public.budget_catalogue enable row level security;

drop policy if exists "catalogue_select_own" on public.budget_catalogue;
create policy "catalogue_select_own" on public.budget_catalogue
  for select using (auth.uid() = user_id);

drop policy if exists "catalogue_insert_own" on public.budget_catalogue;
create policy "catalogue_insert_own" on public.budget_catalogue
  for insert with check (auth.uid() = user_id);

drop policy if exists "catalogue_update_own" on public.budget_catalogue;
create policy "catalogue_update_own" on public.budget_catalogue
  for update using (auth.uid() = user_id);

drop policy if exists "catalogue_delete_own" on public.budget_catalogue;
create policy "catalogue_delete_own" on public.budget_catalogue
  for delete using (auth.uid() = user_id);

-- Migration 005 created its tables without these, which made PostgREST return
-- 404 for a table that plainly existed. Granting explicitly so that cannot
-- happen again. RLS above is what actually gates the rows.
grant usage on schema public to anon, authenticated;
grant all on public.budget_catalogue to anon, authenticated;

notify pgrst, 'reload schema';
