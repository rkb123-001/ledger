-- Fix for the ON CONFLICT failure in migration 007.
--
-- 007 created uniqueness as a partial index. Postgres will not use a partial
-- index for ON CONFLICT unless the query restates the predicate, which
-- PostgREST cannot do, so sync-catalogue failed with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification".
--
-- Replacing it with a plain unique constraint. Safe to run more than once.

drop index if exists public.idx_budget_catalogue_variant;

alter table public.budget_catalogue
  drop constraint if exists budget_catalogue_variant_key;

alter table public.budget_catalogue
  add constraint budget_catalogue_variant_key
  unique (user_id, shopify_variant_id);

notify pgrst, 'reload schema';
