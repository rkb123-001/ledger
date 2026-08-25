export interface BudgetAccount {
  id: string;
  user_id: string;
  hsbc_balance: number;
  monzo_main_balance: number;
  incoming_amount: number;
  incoming_date: string;
  scenario: "with" | "without";
  updated_at: string;
}

export interface BudgetPot {
  id: string;
  user_id: string;
  name: string;
  current_balance: number;
  sort_order: number;
  created_at: string;
}

export interface BudgetItem {
  id: string;
  pot_id: string;
  user_id: string;
  label: string;
  amount: number;
  is_estimate: boolean;
  sort_order: number;
  created_at: string;
}

export interface BudgetDraft {
  id: string;
  user_id: string;
  suggested_pot_id: string | null;
  suggested_pot_name: string | null;
  label: string;
  amount: number;
  is_estimate: boolean;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}

export interface PotWithItems extends BudgetPot {
  items: BudgetItem[];
}

export interface ProductionCost {
  id: string;
  user_id: string;
  category: string;
  description: string;
  cost_low: number;
  cost_high: number;
  pot_name: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

export interface CostBreakdownLine {
  description: string;
  amount: number;
  pot_name: string | null;
  is_estimate: boolean;
}

export interface CostedPiece {
  name: string;
  quantity: number;
  notes: string;
  breakdown: CostBreakdownLine[];
  production_cost: number;
}

export interface CostingResult {
  client_name: string | null;
  order_reference: string | null;
  pieces: CostedPiece[];
  production_subtotal: number;
  margin_multiplier: number;
  suggested_retail: number;
  warnings: string[];
}

export interface OrderQuote {
  id: string;
  user_id: string;
  client_name: string | null;
  order_reference: string | null;
  notes: string | null;
  pieces: CostedPiece[];
  production_subtotal: number;
  suggested_retail: number | null;
  margin_multiplier: number;
  status: string;
  committed_to_pots: boolean;
  created_at: string;
}

// =============================================================
// Multi-account and project budgeting (migration 005)
// =============================================================

export type BankAccountKind =
  | "current"
  | "savings"
  | "incoming"
  | "credit"
  | "cash";

/**
 * One real account. Supersedes the three fixed columns on BudgetAccount,
 * which stay in place so existing installs keep working.
 */
export interface BankAccount {
  id: string;
  user_id: string;
  name: string;
  institution: string | null;
  kind: BankAccountKind;
  balance: number;
  currency: string;
  /** Only meaningful for kind "incoming": when the money is due. */
  expected_date: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type ProjectStatus = "quoted" | "active" | "complete" | "archived";

export interface Project {
  id: string;
  user_id: string;
  name: string;
  client_name: string | null;
  reference: string | null;
  status: ProjectStatus;
  /** Planned spend ceiling. Null means tracked but uncapped. */
  budget_amount: number | null;
  target_margin: number;
  start_date: string | null;
  target_date: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A row of the budget_project_rollup view. Read only. */
export interface ProjectRollup {
  project_id: string;
  user_id: string;
  name: string;
  client_name: string | null;
  status: ProjectStatus;
  budget_amount: number | null;
  target_margin: number;
  target_date: string | null;
  committed_total: number;
  paid_total: number;
  estimated_total: number;
  item_count: number;
  quoted_production: number;
  quoted_retail: number;
  quote_count: number;
  remaining_budget: number | null;
  variance_vs_quote: number;
}
