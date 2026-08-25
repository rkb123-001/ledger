-- Enable realtime broadcasting on budget tables for cross-window sync
-- Run this once in Supabase SQL Editor

alter publication supabase_realtime add table public.budget_accounts;
alter publication supabase_realtime add table public.budget_pots;
alter publication supabase_realtime add table public.budget_items;
alter publication supabase_realtime add table public.budget_drafts;
