-- =============================================================
-- Example rate card: a metalwork and jewellery practice
-- =============================================================
-- OPTIONAL. No migration runs this file, and nothing in Ledger
-- depends on it. It exists so there is a worked example of what a
-- filled-in rate card looks like: how a range is used where a price
-- genuinely varies, where a fixed price is entered as a range with
-- equal ends, and how lines are pointed at the pot that pays them.
--
-- These are one practice's costs, in one city, in one year. They are
-- not defaults and they are not a recommendation. If your work is
-- research, design, writing, film or anything else, the categories
-- below are the wrong ones for you, and the app lets you rename or
-- replace every one of them.
--
-- To use it: replace YOUR_USER_ID_HERE with your auth.users.id
-- (Supabase, Authentication, Users), then run it once. Or take it as
-- a shape to imitate and write your own.
-- =============================================================

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
