import { useEffect, useRef, useState } from "react";
import type { BudgetItem, BudgetPot, PotWithItems } from "../lib/types";
import { fmt, isEstimateLabel } from "../lib/format";

interface PotCardProps {
  pot: PotWithItems;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onUpdatePot: (patch: Partial<BudgetPot>) => void;
  onDeletePot: () => void;
  onAddItem: () => Promise<BudgetItem | null>;
  onUpdateItem: (itemId: string, patch: Partial<BudgetItem>) => void;
  onDeleteItem: (itemId: string) => void;
}

type FocusedAmountField =
  | { type: "pot-balance" }
  | { type: "item-amount"; itemId: string }
  | null;

function valueToInput(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function parseDraftNumber(raw: string): number | null {
  const normalised = raw.replace(",", ".").trim();

  // These are valid "in progress" typing states, but not numbers yet.
  if (
    normalised === "" ||
    normalised === "-" ||
    normalised === "." ||
    normalised === "-."
  ) {
    return null;
  }

  const parsed = Number(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

function finaliseNumber(raw: string): number {
  return parseDraftNumber(raw) ?? 0;
}

export function PotCard({
  pot,
  collapsed,
  onToggleCollapse,
  onUpdatePot,
  onDeletePot,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
}: PotCardProps) {
  const [editingPotName, setEditingPotName] = useState(false);
  const [potNameDraft, setPotNameDraft] = useState(pot.name);

  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [itemLabelDrafts, setItemLabelDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(pot.items.map((item) => [item.id, item.label]))
  );

  const [potBalanceDraft, setPotBalanceDraft] = useState(valueToInput(pot.current_balance));
  const [itemAmountDrafts, setItemAmountDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(pot.items.map((item) => [item.id, valueToInput(item.amount)]))
  );

  const focusedAmountField = useRef<FocusedAmountField>(null);

  // Keep local drafts in step with server/parent state, but do not overwrite the
  // field the user is actively typing into.
  useEffect(() => {
    if (!editingPotName) {
      setPotNameDraft(pot.name);
    }

    if (focusedAmountField.current?.type !== "pot-balance") {
      setPotBalanceDraft(valueToInput(pot.current_balance));
    }

    setItemLabelDrafts((prev) => {
      const next: Record<string, string> = {};

      for (const item of pot.items) {
        if (editingItem === item.id) {
          next[item.id] = prev[item.id] ?? item.label;
        } else {
          next[item.id] = item.label;
        }
      }

      return next;
    });

    setItemAmountDrafts((prev) => {
      const next: Record<string, string> = {};

      for (const item of pot.items) {
        if (
          focusedAmountField.current?.type === "item-amount" &&
          focusedAmountField.current.itemId === item.id
        ) {
          next[item.id] = prev[item.id] ?? valueToInput(item.amount);
        } else {
          next[item.id] = valueToInput(item.amount);
        }
      }

      return next;
    });
  }, [pot.id, pot.name, pot.current_balance, pot.items, editingPotName, editingItem]);

  const potTotal = pot.items.reduce((s, i) => s + Number(i.amount), 0);
  const diff = Number(pot.current_balance) - potTotal;
  const statusClass = diff >= 0 ? (diff > 0 ? "overfunded" : "ok") : "shortfall";
  const statusText = diff >= 0 ? (diff > 0 ? `+${fmt(diff)}` : "Exact") : `−${fmt(diff)}`;

  async function handleAddItem() {
    const newItem = await onAddItem();

    if (newItem) {
      setItemLabelDrafts((prev) => ({ ...prev, [newItem.id]: newItem.label }));
      setItemAmountDrafts((prev) => ({ ...prev, [newItem.id]: valueToInput(newItem.amount) }));
      setEditingItem(newItem.id);
    }
  }

  function startEditingPotName() {
    setPotNameDraft(pot.name);
    setEditingPotName(true);
  }

  function commitPotName() {
    const nextName = potNameDraft.trim() || "Untitled pot";
    setPotNameDraft(nextName);
    onUpdatePot({ name: nextName });
    setEditingPotName(false);
  }

  function cancelPotNameEdit() {
    setPotNameDraft(pot.name);
    setEditingPotName(false);
  }

  function updatePotBalanceDraft(raw: string) {
    setPotBalanceDraft(raw);

    const parsed = parseDraftNumber(raw);
    if (parsed !== null) {
      onUpdatePot({ current_balance: parsed });
    }
  }

  function commitPotBalanceDraft() {
    const nextBalance = finaliseNumber(potBalanceDraft);
    setPotBalanceDraft(valueToInput(nextBalance));
    onUpdatePot({ current_balance: nextBalance });
    focusedAmountField.current = null;
  }

  function startEditingItemLabel(item: BudgetItem) {
    setItemLabelDrafts((prev) => ({ ...prev, [item.id]: item.label }));
    setEditingItem(item.id);
  }

  function updateItemLabelDraft(itemId: string, raw: string) {
    setItemLabelDrafts((prev) => ({ ...prev, [itemId]: raw }));
    onUpdateItem(itemId, { label: raw });
  }

  function commitItemLabel(item: BudgetItem) {
    const nextLabel = (itemLabelDrafts[item.id] ?? item.label).trim() || "Untitled item";
    setItemLabelDrafts((prev) => ({ ...prev, [item.id]: nextLabel }));
    onUpdateItem(item.id, { label: nextLabel });
    setEditingItem(null);
  }

  function cancelItemLabelEdit(item: BudgetItem) {
    setItemLabelDrafts((prev) => ({ ...prev, [item.id]: item.label }));
    setEditingItem(null);
  }

  function updateItemAmountDraft(itemId: string, raw: string) {
    setItemAmountDrafts((prev) => ({ ...prev, [itemId]: raw }));

    const parsed = parseDraftNumber(raw);
    if (parsed !== null) {
      onUpdateItem(itemId, { amount: parsed });
    }
  }

  function commitItemAmountDraft(item: BudgetItem) {
    const nextAmount = finaliseNumber(itemAmountDrafts[item.id] ?? valueToInput(item.amount));
    setItemAmountDrafts((prev) => ({ ...prev, [item.id]: valueToInput(nextAmount) }));
    onUpdateItem(item.id, { amount: nextAmount });
    focusedAmountField.current = null;
  }

  return (
    <div className="card">
      <div className="pot-header">
        <button
          className="collapse-btn"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand pot" : "Collapse pot"}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>

        <div className="pot-title-wrap">
          {editingPotName ? (
            <input
              className="pot-title-edit"
              autoFocus
              value={potNameDraft}
              onChange={(e) => {
                const raw = e.target.value;
                setPotNameDraft(raw);
                onUpdatePot({ name: raw });
              }}
              onBlur={commitPotName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }

                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelPotNameEdit();
                }
              }}
            />
          ) : (
            <span
              className="pot-title"
              onClick={(e) => {
                e.stopPropagation();
                startEditingPotName();
              }}
            >
              {pot.name}
            </span>
          )}

          {collapsed && (
            <span className={`pot-status ${statusClass}`} style={{ marginLeft: 8 }}>
              {statusText}
            </span>
          )}

          <button className="pot-delete-btn" onClick={onDeletePot} title="Delete pot">
            ×
          </button>
        </div>

        <div className="pot-current-wrap">
          <span className="pot-current-label">Pot:</span>
          <input
            className="pot-current-input"
            type="text"
            inputMode="decimal"
            value={potBalanceDraft}
            onFocus={() => {
              focusedAmountField.current = { type: "pot-balance" };
            }}
            onChange={(e) => updatePotBalanceDraft(e.target.value)}
            onBlur={commitPotBalanceDraft}
          />
        </div>
      </div>

      {!collapsed && (
        <>
          {pot.items.map((item) => {
            const isEst = item.is_estimate || isEstimateLabel(item.label);
            const isEditing = editingItem === item.id;

            return (
              <div key={item.id} className="item-block">
                {isEditing ? (
                  <input
                    className="item-edit"
                    autoFocus
                    value={itemLabelDrafts[item.id] ?? item.label}
                    onChange={(e) => updateItemLabelDraft(item.id, e.target.value)}
                    onBlur={() => commitItemLabel(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }

                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelItemLabelEdit(item);
                      }
                    }}
                  />
                ) : (
                  <span
                    className={`item-label ${isEst ? "est" : ""}`}
                    onClick={() => startEditingItemLabel(item)}
                  >
                    {item.label}
                  </span>
                )}

                <div className="item-controls">
                  <input
                    className="item-amount-input"
                    type="text"
                    inputMode="decimal"
                    value={itemAmountDrafts[item.id] ?? valueToInput(item.amount)}
                    onFocus={() => {
                      focusedAmountField.current = { type: "item-amount", itemId: item.id };
                    }}
                    onChange={(e) => updateItemAmountDraft(item.id, e.target.value)}
                    onBlur={() => commitItemAmountDraft(item)}
                  />

                  <button
                    className="item-delete"
                    onClick={() => onDeleteItem(item.id)}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}

          <button className="add-btn" onClick={handleAddItem}>
            + Add item
          </button>

          <div className="pot-total">
            <span>Total needed</span>
            <span>{fmt(potTotal)}</span>
          </div>

          <div className="pot-total" style={{ border: "none", paddingTop: 4 }}>
            <span>Status</span>
            <span className={`pot-status ${statusClass}`}>{statusText}</span>
          </div>
        </>
      )}
    </div>
  );
}
