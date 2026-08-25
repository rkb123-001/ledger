import { useState } from "react";
import { supabase } from "../lib/supabase";
import type { BudgetDraft, BudgetPot } from "../lib/types";
import { fmt } from "../lib/format";

interface DraftsReviewProps {
  drafts: BudgetDraft[];
  pots: BudgetPot[];
  onAccepted: () => void;
}

interface DraftEdit {
  label?: string;
  amount?: number;
  pot_id?: string;
  is_estimate?: boolean;
}

export function DraftsReview({ drafts, pots, onAccepted }: DraftsReviewProps) {
  const [edits, setEdits] = useState<Record<string, DraftEdit>>({});

  if (drafts.length === 0) return null;

  function getEdit(draft: BudgetDraft): Required<DraftEdit> {
    const e = edits[draft.id] ?? {};
    return {
      label: e.label ?? draft.label,
      amount: e.amount ?? Number(draft.amount),
      pot_id: e.pot_id ?? draft.suggested_pot_id ?? "",
      is_estimate: e.is_estimate ?? draft.is_estimate,
    };
  }

  function patchEdit(id: string, patch: DraftEdit) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function acceptDraft(draft: BudgetDraft) {
    const edit = getEdit(draft);
    if (!edit.pot_id) {
      alert("Choose a pot before accepting");
      return;
    }

    const { data: existingItems } = await supabase
      .from("budget_items")
      .select("sort_order")
      .eq("pot_id", edit.pot_id)
      .order("sort_order", { ascending: false })
      .limit(1);
    const nextSort = (existingItems?.[0]?.sort_order ?? 0) + 1;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error: insertError } = await supabase.from("budget_items").insert({
      pot_id: edit.pot_id,
      user_id: user.id,
      label: edit.label,
      amount: edit.amount,
      is_estimate: edit.is_estimate,
      sort_order: nextSort,
    });

    if (insertError) {
      alert("Could not save: " + insertError.message);
      return;
    }

    await supabase.from("budget_drafts").delete().eq("id", draft.id);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[draft.id];
      return next;
    });
    onAccepted();
  }

  async function rejectDraft(draft: BudgetDraft) {
    await supabase.from("budget_drafts").delete().eq("id", draft.id);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[draft.id];
      return next;
    });
    onAccepted();
  }

  async function rejectAll() {
    await supabase.from("budget_drafts").delete().in("id", drafts.map((d) => d.id));
    setEdits({});
    onAccepted();
  }

  return (
    <div className="drafts-section">
      <div className="drafts-title">
        {drafts.length} pending draft{drafts.length === 1 ? "" : "s"}
        <button
          onClick={rejectAll}
          style={{
            float: "right",
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            fontSize: 12,
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          Discard all
        </button>
      </div>
      {drafts.map((draft) => {
        const edit = getEdit(draft);
        const matchingPot = pots.find(
          (p) => p.name.toLowerCase() === draft.suggested_pot_name?.toLowerCase()
        );
        const defaultPotId = edit.pot_id || matchingPot?.id || "";

        return (
          <div key={draft.id} className="draft-row">
            <div className="draft-top">
              <input
                className="draft-label"
                value={edit.label}
                onChange={(e) => patchEdit(draft.id, { label: e.target.value })}
                style={{
                  padding: "4px 8px",
                  border: "0.5px solid var(--border-strong)",
                  borderRadius: 6,
                  background: "var(--panel)",
                  color: "var(--text)",
                }}
              />
              <div className="draft-meta">
                <select
                  value={defaultPotId}
                  onChange={(e) => patchEdit(draft.id, { pot_id: e.target.value })}
                >
                  <option value="">— Choose pot —</option>
                  {pots.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  className="amount"
                  type="number"
                  step="0.01"
                  value={edit.amount}
                  onChange={(e) =>
                    patchEdit(draft.id, { amount: parseFloat(e.target.value) || 0 })
                  }
                />
                <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  <input
                    type="checkbox"
                    checked={edit.is_estimate}
                    onChange={(e) => patchEdit(draft.id, { is_estimate: e.target.checked })}
                    style={{ marginRight: 4 }}
                  />
                  est.
                </label>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  Suggested: {draft.suggested_pot_name} · {fmt(Number(draft.amount))}
                </span>
              </div>
            </div>
            <div className="draft-actions">
              <button className="draft-reject" onClick={() => rejectDraft(draft)}>
                Reject
              </button>
              <button className="draft-accept" onClick={() => acceptDraft(draft)}>
                Accept
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
