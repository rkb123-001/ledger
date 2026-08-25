import { useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { fmt } from "../lib/format";
import { EditableNumberInput } from "./EditableNumberInput";
import type { BankAccount, BankAccountKind } from "../lib/types";

const KIND_LABELS: Record<BankAccountKind, string> = {
  current: "Current",
  savings: "Reserve",
  incoming: "Incoming",
  credit: "Credit",
  cash: "Cash",
};

const KIND_ORDER: BankAccountKind[] = [
  "current",
  "cash",
  "savings",
  "incoming",
  "credit",
];

export interface AccountTotals {
  /** Spendable now: current and cash accounts. */
  available: number;
  /** The primary account, the one transfers are pulled from. */
  primaryBalance: number;
  /** Other spendable accounts, held outside the pots. */
  bufferBalance: number;
  /** Owed but not yet received. Never counted as available. */
  incoming: number;
  /** Held back deliberately. */
  reserves: number;
  /** Owed out on credit, held as a positive number. */
  credit: number;
}

/**
 * Derive the figures the rebalance maths needs from an arbitrary set of
 * accounts.
 *
 * The old schema hardcoded these as three columns, which meant the roles
 * were fixed to two named banks. Here the roles are positional: the
 * first active current account is primary, anything else spendable is
 * buffer. Incoming is deliberately excluded from available, because
 * money that has not arrived should never make a balance look healthier
 * than it is.
 */
export function deriveTotals(accounts: BankAccount[]): AccountTotals {
  const active = accounts
    .filter((a) => a.is_active)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);

  const spendable = active.filter((a) => a.kind === "current" || a.kind === "cash");
  const primary = spendable[0];
  const primaryBalance = primary ? Number(primary.balance) : 0;
  const bufferBalance = spendable
    .slice(1)
    .reduce((sum, a) => sum + Number(a.balance), 0);

  const sumKind = (kind: BankAccountKind) =>
    active
      .filter((a) => a.kind === kind)
      .reduce((sum, a) => sum + Number(a.balance), 0);

  return {
    available: primaryBalance + bufferBalance,
    primaryBalance,
    bufferBalance,
    incoming: sumKind("incoming"),
    reserves: sumKind("savings"),
    credit: sumKind("credit"),
  };
}

interface AccountsPanelProps {
  accounts: BankAccount[];
  userId: string;
  onChanged: () => void;
}

export function AccountsPanel({ accounts, userId, onChanged }: AccountsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(
    () => accounts.slice().sort((a, b) => a.sort_order - b.sort_order),
    [accounts]
  );
  const totals = useMemo(() => deriveTotals(accounts), [accounts]);
  const primaryId = useMemo(() => {
    const spendable = accounts
      .filter((a) => a.is_active && (a.kind === "current" || a.kind === "cash"))
      .sort((a, b) => a.sort_order - b.sort_order);
    return spendable[0]?.id ?? null;
  }, [accounts]);

  async function patch(id: string, changes: Partial<BankAccount>) {
    await supabase
      .from("budget_bank_accounts")
      .update(changes)
      .eq("id", id)
      .eq("user_id", userId);
    onChanged();
  }

  async function addAccount() {
    if (busy) return;
    setBusy(true);
    const nextOrder =
      accounts.reduce((max, a) => Math.max(max, a.sort_order), 0) + 1;
    await supabase.from("budget_bank_accounts").insert({
      user_id: userId,
      name: "New account",
      kind: "current",
      balance: 0,
      sort_order: nextOrder,
    });
    setBusy(false);
    onChanged();
  }

  async function removeAccount(id: string, name: string) {
    if (!window.confirm(`Remove "${name}"? This does not affect any pots.`)) return;
    await supabase
      .from("budget_bank_accounts")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);
    onChanged();
  }

  return (
    <section className="accounts-panel" aria-label="Accounts">
      <div className="accounts-panel-header">
        <h2 className="accounts-panel-title">Accounts</h2>
        <button className="add-btn" onClick={addAccount} disabled={busy}>
          Add account
        </button>
      </div>

      <div className="accounts-grid">
        {sorted.map((acct) => {
          const isPrimary = acct.id === primaryId;
          return (
            <div
              key={acct.id}
              className={`account-card kind-${acct.kind}${
                acct.is_active ? "" : " inactive"
              }`}
            >
              <div className="account-card-top">
                {editingId === acct.id ? (
                  <input
                    className="account-name-edit"
                    defaultValue={acct.name}
                    autoFocus
                    aria-label="Account name"
                    onBlur={(e) => {
                      const name = e.target.value.trim() || "Untitled";
                      setEditingId(null);
                      if (name !== acct.name) patch(acct.id, { name });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    className="account-name"
                    onClick={() => setEditingId(acct.id)}
                    title="Rename"
                  >
                    {acct.name}
                  </button>
                )}

                <select
                  className="account-kind"
                  value={acct.kind}
                  aria-label="Account type"
                  onChange={(e) =>
                    patch(acct.id, { kind: e.target.value as BankAccountKind })
                  }
                >
                  {KIND_ORDER.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>

              <EditableNumberInput
                className="account-input"
                value={acct.balance}
                ariaLabel={`${acct.name} balance`}
                onValueChange={(balance) => patch(acct.id, { balance })}
              />

              <div className="account-card-meta">
                {isPrimary && <span className="account-tag">Primary</span>}
                {acct.kind === "incoming" && (
                  <input
                    className="date-input"
                    type="date"
                    aria-label="Expected date"
                    value={acct.expected_date ?? ""}
                    onChange={(e) =>
                      patch(acct.id, { expected_date: e.target.value || null })
                    }
                  />
                )}
                <button
                  className="account-toggle"
                  onClick={() => patch(acct.id, { is_active: !acct.is_active })}
                  title={acct.is_active ? "Exclude from totals" : "Include in totals"}
                >
                  {acct.is_active ? "Active" : "Excluded"}
                </button>
                <button
                  className="account-delete"
                  onClick={() => removeAccount(acct.id, acct.name)}
                  aria-label={`Remove ${acct.name}`}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="accounts-totals">
        <div className="accounts-total">
          <span>Available now</span>
          <strong>{fmt(totals.available)}</strong>
        </div>
        {totals.incoming > 0 && (
          <div className="accounts-total muted">
            <span>Incoming, not yet received</span>
            <strong>{fmt(totals.incoming)}</strong>
          </div>
        )}
        {totals.reserves > 0 && (
          <div className="accounts-total muted">
            <span>Held in reserve</span>
            <strong>{fmt(totals.reserves)}</strong>
          </div>
        )}
        {totals.credit > 0 && (
          <div className="accounts-total muted">
            <span>On credit</span>
            <strong>{fmt(totals.credit)}</strong>
          </div>
        )}
      </div>
    </section>
  );
}
