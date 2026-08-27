-- Closing a quote: what the job actually took.
--
-- 005 added actual_production_cost as the input to budget_prediction_factor,
-- but nothing ever wrote to it, so the factor sat at 1.0 permanently and the
-- prediction model could not calibrate. The Quotes panel now writes it.
--
-- Hours are added here for the same reason and are the more useful signal:
-- cost estimates drift, time estimates drift further and more consistently.

alter table public.budget_order_quotes
  add column if not exists quoted_hours numeric(6,2);

alter table public.budget_order_quotes
  add column if not exists actual_hours numeric(6,2);

alter table public.budget_order_quotes
  add column if not exists closed_at timestamptz;

comment on column public.budget_order_quotes.actual_production_cost is
  'What the job really cost. Null until closed. Feeds budget_prediction_factor.';
comment on column public.budget_order_quotes.actual_hours is
  'Studio hours the job really took. Null until closed.';

grant all on public.budget_order_quotes to anon, authenticated;

notify pgrst, 'reload schema';
