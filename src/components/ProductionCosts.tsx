import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { BudgetPot, ProductionCost } from "../lib/types";
import { fmt } from "../lib/format";

interface ProductionCostsProps {
  pots: BudgetPot[];
  onClose: () => void;
}

export function ProductionCosts({ pots, onClose }: ProductionCostsProps) {
  const [costs, setCosts] = useState<ProductionCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Pending writes per row (id → latest patch waiting to save)
  const pendingPatches = useRef<Map<string, Partial<ProductionCost>>>(new Map());
  const saveTimer = useRef<number | null>(null);

  async function fetchCosts() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: rows } = await supabase
      .from("budget_production_costs")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });
    const typedRows = (rows ?? []) as ProductionCost[];
    setCosts(typedRows);
    setLoading(false);
  }

  // Write all pending patches to DB immediately
  async function flushPending() {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingPatches.current.size === 0) return;
    const toFlush = Array.from(pendingPatches.current.entries());
    pendingPatches.current.clear();
    await Promise.all(
      toFlush.map(([id, patch]) =>
        supabase.from("budget_production_costs").update(patch).eq("id", id)
      )
    );
  }

  useEffect(() => {
    fetchCosts();
    document.body.style.overflow = "hidden";

    // Flush before tab close / app backgrounded
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Synchronously fire pending saves (won't await but at least dispatches)
        void flushPending();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // Flush on unmount
      void flushPending();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateLocal(id: string, patch: Partial<ProductionCost>) {
    // Update UI immediately
    setCosts((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    // Merge into pending queue
    const existing = pendingPatches.current.get(id) ?? {};
    pendingPatches.current.set(id, { ...existing, ...patch });
    // Restart debounce timer
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void flushPending();
    }, 500);
  }

  async function deleteCost(id: string) {
    pendingPatches.current.delete(id);
    setCosts((prev) => prev.filter((c) => c.id !== id));
    await supabase.from("budget_production_costs").delete().eq("id", id);
  }

  async function addCost(category: string) {
    await flushPending(); // make sure prior edits are saved before adding
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const nextSort = (costs.at(-1)?.sort_order ?? 0) + 1;
    const { data } = await supabase
      .from("budget_production_costs")
      .insert({
        user_id: user.id,
        category,
        description: "New rate",
        cost_low: 0,
        cost_high: 0,
        sort_order: nextSort,
      })
      .select()
      .single();
    if (data) {
      setCosts((prev) => [...prev, data as ProductionCost]);
      setEditingId(data.id);
    }
  }

  async function addNewCategory() {
    const name = prompt("New category name:");
    if (!name?.trim()) return;
    await addCost(name.trim());
  }

  async function handleClose() {
    await flushPending();
    onClose();
  }

  // Group by category for display
  const grouped = costs.reduce((acc: Record<string, ProductionCost[]>, c: ProductionCost) => {
    if (!acc[c.category]) acc[c.category] = [];
    acc[c.category].push(c);
    return acc;
  }, {} as Record<string, ProductionCost[]>);

  return (
    <div className="settings-overlay" onClick={handleClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Production costs</h2>
          <button className="settings-close" onClick={handleClose}>×</button>
        </div>
        <div className="settings-description">
          Your typical production rates. The order costing tool uses these to estimate budgets when you upload a client order.
        </div>

        {loading && <div className="loading">Loading...</div>}

        {!loading &&
          Object.entries(grouped).map(([category, rows]) => (
            <div key={category} className="cost-group">
              <h3 className="cost-group-title">{category}</h3>
              {rows.map((cost) => {
                const isEditing = editingId === cost.id;
                return (
                  <div key={cost.id} className="cost-row">
                    <div className="cost-row-main">
                      {isEditing ? (
                        <input
                          autoFocus
                          className="cost-desc-edit"
                          value={cost.description}
                          onChange={(e) => updateLocal(cost.id, { description: e.target.value })}
                          onBlur={() => {
                            void flushPending();
                            setEditingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        <span className="cost-desc" onClick={() => setEditingId(cost.id)}>
                          {cost.description}
                        </span>
                      )}
                      <div className="cost-controls">
                        <span className="cost-label">£</span>
                        <input
                          className="cost-amount"
                          type="number"
                          step="0.01"
                          value={cost.cost_low}
                          onChange={(e) =>
                            updateLocal(cost.id, { cost_low: parseFloat(e.target.value) || 0 })
                          }
                          onBlur={() => void flushPending()}
                        />
                        <span className="cost-dash">–</span>
                        <input
                          className="cost-amount"
                          type="number"
                          step="0.01"
                          value={cost.cost_high}
                          onChange={(e) =>
                            updateLocal(cost.id, { cost_high: parseFloat(e.target.value) || 0 })
                          }
                          onBlur={() => void flushPending()}
                        />
                        <button className="cost-delete" onClick={() => deleteCost(cost.id)}>×</button>
                      </div>
                    </div>
                    <div className="cost-row-meta">
                      <select
                        className="cost-pot-select"
                        value={cost.pot_name ?? ""}
                        onChange={(e) =>
                          updateLocal(cost.id, { pot_name: e.target.value || null })
                        }
                        onBlur={() => void flushPending()}
                      >
                        <option value="">— No pot —</option>
                        {pots.map((p) => (
                          <option key={p.id} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                      <input
                        className="cost-category"
                        placeholder="Category"
                        value={cost.category}
                        onChange={(e) => updateLocal(cost.id, { category: e.target.value })}
                        onBlur={() => void flushPending()}
                      />
                      <span className="cost-mid">midpoint: {fmt((Number(cost.cost_low) + Number(cost.cost_high)) / 2)}</span>
                    </div>
                  </div>
                );
              })}
              <button
                className="add-btn"
                onClick={() => addCost(category)}
                style={{ marginTop: 4 }}
              >
                + Add to {category}
              </button>
            </div>
          ))}

        <button className="add-pot-btn" onClick={addNewCategory} style={{ marginTop: 16 }}>
          + Add new category
        </button>
      </div>
    </div>
  );
}
