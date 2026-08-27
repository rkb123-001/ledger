-- Studio hours on pot items.
--
-- Money answers "can I afford this". For a solo practice the binding constraint
-- is usually the other one: how many hours at the bench are already spoken for.
-- Hours ride on the same object as the money and clear the same way, so ticking
-- an item off removes both at once. No separate tracker to keep in step.

alter table public.budget_items
  add column if not exists hours numeric(6,2) not null default 0;

comment on column public.budget_items.hours is
  'Estimated studio hours for this item. Outstanding hours are those on unpaid items.';

grant all on public.budget_items to anon, authenticated;

notify pgrst, 'reload schema';
