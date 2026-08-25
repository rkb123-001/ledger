-- Optional: seed a starting set of pots and items.
--
-- This is an EXAMPLE, not real data. The pot names are the categories a
-- hallmarked jewellery practice actually needs; the amounts and client
-- references are invented.
--
-- An earlier version of this file contained a real user id, real client
-- names and real invoice amounts. Do not put live financial data or
-- third-party names in a tracked file. Keep your own seed in
-- 002_seed_data.local.sql, which is gitignored.
--
-- Replace YOUR_USER_ID_HERE with your auth.users.id (Supabase → Authentication
-- → Users), then run this once, after 001_initial_schema.sql.

do $$
declare
  v_user_id uuid := 'YOUR_USER_ID_HERE'::uuid;
  v_pot_id  uuid;
begin
  -- Account row. Superseded by budget_bank_accounts in migration 005,
  -- which backfills from these three values.
  insert into public.budget_accounts
    (user_id, hsbc_balance, monzo_main_balance, incoming_amount, incoming_date)
  values (v_user_id, 0, 0, 0, '')
  on conflict (user_id) do nothing;

  -- VAT set aside on each invoice, held until the return is filed
  insert into public.budget_pots (user_id, name, current_balance, sort_order)
  values (v_user_id, 'VAT', 0, 1) returning id into v_pot_id;
  insert into public.budget_items (pot_id, user_id, label, amount, sort_order) values
    (v_pot_id, v_user_id, 'Commission 0001 — VAT on invoice', 40, 1),
    (v_pot_id, v_user_id, 'Commission 0002 — VAT on invoice', 60, 2),
    (v_pot_id, v_user_id, 'VAT collected this quarter — set aside for HMRC', 100, 3);

  -- Outsourced casting
  insert into public.budget_pots (user_id, name, current_balance, sort_order)
  values (v_user_id, 'Casters', 0, 2) returning id into v_pot_id;
  insert into public.budget_items (pot_id, user_id, label, amount, sort_order) values
    (v_pot_id, v_user_id, 'Silver casting batch fee', 200, 1),
    (v_pot_id, v_user_id, 'Pendant — silver casting (est.)', 40, 2),
    (v_pot_id, v_user_id, 'Ring — silver casting (est.)', 30, 3);

  -- Assay Office
  insert into public.budget_pots (user_id, name, current_balance, sort_order)
  values (v_user_id, 'Hallmarking', 0, 3) returning id into v_pot_id;
  insert into public.budget_items (pot_id, user_id, label, amount, sort_order) values
    (v_pot_id, v_user_id, 'Silver hallmarks — batch', 50, 1),
    (v_pot_id, v_user_id, 'Gold hallmark (est.)', 40, 2);

  -- Stock metal, chain, findings, packaging
  insert into public.budget_pots (user_id, name, current_balance, sort_order)
  values (v_user_id, 'Materials', 0, 4) returning id into v_pot_id;
  insert into public.budget_items (pot_id, user_id, label, amount, sort_order) values
    (v_pot_id, v_user_id, 'Chain and findings', 80, 1),
    (v_pot_id, v_user_id, 'Presentation packaging', 40, 2);

  -- Recurring studio overheads
  insert into public.budget_pots (user_id, name, current_balance, sort_order)
  values (v_user_id, 'Studio and software', 0, 5) returning id into v_pot_id;
  insert into public.budget_items (pot_id, user_id, label, amount, sort_order) values
    (v_pot_id, v_user_id, 'Studio rent — monthly', 250, 1),
    (v_pot_id, v_user_id, 'Software and services — monthly', 40, 2);
end $$;
