-- A heartbeat the keep-awake workflow can write to.
--
-- Migration 011's companion lesson: between 25 October and 1 November the
-- workflow pinged this project every three days and every run returned HTTP
-- 200, and Supabase paused it anyway on 4 November, seven days after the last
-- real use. A read that RLS answers with an empty array was evidently not
-- counted as activity. A write is not ambiguous.
--
-- The table is locked down and has no policies at all. Only the security
-- definer function below can touch it, so the publishable key cannot be used
-- to read or write the row directly.

create table if not exists public.app_heartbeat (
  id smallint primary key default 1,
  pinged_at timestamptz not null default now(),
  constraint app_heartbeat_single_row check (id = 1)
);

insert into public.app_heartbeat (id) values (1) on conflict (id) do nothing;

alter table public.app_heartbeat enable row level security;

-- Bumps the timestamp and returns it. security definer so the caller needs no
-- rights on the table itself; the function is the only door.
create or replace function public.ping_heartbeat()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update public.app_heartbeat
     set pinged_at = now()
   where id = 1
  returning pinged_at;
$$;

revoke all on function public.ping_heartbeat() from public;
grant execute on function public.ping_heartbeat() to anon, authenticated;

notify pgrst, 'reload schema';
