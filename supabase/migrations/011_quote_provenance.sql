-- Where a pot item came from.
--
-- Until now a quote committed to pots left no trace on the items it created:
-- the only link was a client name in the label. That made abandoning a job a
-- manual hunt through every pot. These columns carry the quote id through the
-- draft and onto the item, so the costs can be removed in one action.
--
-- on delete set null, not cascade: deleting a quote should be a decision about
-- the quote, and never silently remove money the pots are still holding.

alter table public.budget_drafts
  add column if not exists source_quote_id uuid
  references public.budget_order_quotes(id) on delete set null;

alter table public.budget_items
  add column if not exists source_quote_id uuid
  references public.budget_order_quotes(id) on delete set null;

create index if not exists idx_budget_items_source_quote
  on public.budget_items(user_id, source_quote_id);

-- PostgREST returns 404 for a table the role cannot address, which reads like
-- an unmigrated database. Grant explicitly, every time.
grant all on public.budget_drafts to anon, authenticated;
grant all on public.budget_items to anon, authenticated;

notify pgrst, 'reload schema';
