import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { BudgetPot, ProductionCost, Project } from "../lib/types";
import { fmt } from "../lib/format";
import { allocateFromRate } from "../lib/predict";
import type { RatePoint } from "../lib/predict";
import { RateBlocks } from "./RateBlocks";

interface ProductionCostsProps {
  pots: BudgetPot[];
  /** Empty when migration 005 has not been run. The project picker hides. */
  projects: Project[];
  /** Called after a rate is committed, so the pots and rollups refetch. */
  onAdded: () => void;
  onClose: () => void;
}

const POINT_LABELS: Record<RatePoint, string> = {
  low: "Low",
  mid: "Mid",
  high: "High",
};

const POINT_ORDER: RatePoint[] = ["low", "mid", "high"];

/** What the add strip is holding before it is committed. */
interface AddDraft {
  point: RatePoint;
  quantity: number;
  potId: string;
  projectId: string | null;
}

/**
 * The insert payload. project_id is optional because it is omitted
 * entirely against an unmigrated database rather than sent as null.
 */
interface NewItemRow {
  pot_id: string;
  user_id: string;
  label: string;
  amount: number;
  is_estimate: boolean;
  sort_order: number;
  project_id?: string;
}

interface AddReceipt {
  costId: string;
  amount: number;
  potName: string;
  projectName: string | null;
  isEstimate: boolean;
}

export function ProductionCosts({
  pots,
  projects,
  onAdded,
  onClose,
}: ProductionCostsProps) {
  const [costs, setCosts] = useState<ProductionCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [panelError, setPanelError] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AddDraft | null>(null);
  const [addError, setAddError] = useState("");
  const [receipt, setReceipt] = useState<AddReceipt | null>(null);
  const [committing, setCommitting] = useState(false);
  // Costing a job means adding several rates to the same project in one
  // sitting, so the last choice is the sensible default for the next.
  const lastProjectId = useRef<string | null>(null);
  // Pending writes per row (id → latest patch waiting to save)
  const pendingPatches = useRef<Map<string, Partial<ProductionCost>>>(new Map());
  const saveTimer = useRef<number | null>(null);

  // Archived and completed projects are history, not somewhere to file new spend.
  const assignableProjects = projects.filter(
    (p) => p.status !== "archived" && p.status !== "complete"
  );

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

  function openAdd(cost: ProductionCost) {
    setAddError("");
    setReceipt(null);
    // The pot named on the rate is where this cost belongs by default;
    // that field exists precisely so this does not have to be picked again.
    const matched = pots.find(
      (p) => p.name.toLowerCase() === (cost.pot_name ?? "").toLowerCase()
    );
    setDraft({
      point: "mid",
      quantity: 1,
      potId: matched?.id ?? pots[0]?.id ?? "",
      projectId:
        assignableProjects.some((p) => p.id === lastProjectId.current)
          ? lastProjectId.current
          : null,
    });
    setAddingId(cost.id);
  }

  function cancelAdd() {
    setAddingId(null);
    setDraft(null);
    setAddError("");
  }

  /**
   * Commit one rate card line into a pot as a real budget item.
   *
   * The arithmetic is not done here: allocateFromRate decides what a
   * range plus a quantity is worth and whether the result is still an
   * estimate. This function only writes it down.
   */
  async function confirmAdd(cost: ProductionCost) {
    if (!draft || !draft.potId || committing) return;

    setCommitting(true);
    setAddError("");
    await flushPending();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setAddError("Not signed in.");
      setCommitting(false);
      return;
    }

    const alloc = allocateFromRate(cost, {
      point: draft.point,
      quantity: draft.quantity,
    });

    const pot = pots.find((p) => p.id === draft.potId);
    const project = assignableProjects.find((p) => p.id === draft.projectId);

    // Sort order is read rather than derived from props, because the pots
    // passed in may be a beat behind a concurrent edit in the main view.
    const { data: lastItem } = await supabase
      .from("budget_items")
      .select("sort_order")
      .eq("pot_id", draft.potId)
      .eq("user_id", user.id)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    const qtyText = alloc.quantity > 1 ? ` x${alloc.quantity}` : "";
    const row: NewItemRow = {
      pot_id: draft.potId,
      user_id: user.id,
      label: `${cost.description}${qtyText}`,
      amount: alloc.amount,
      is_estimate: alloc.isEstimate,
      sort_order: Number(lastItem?.sort_order ?? 0) + 1,
    };
    const rowWithProject: NewItemRow = draft.projectId
      ? { ...row, project_id: draft.projectId }
      : row;

    let { error } = await supabase.from("budget_items").insert(rowWithProject);

    // project_id only exists once migration 005 has run. The rest of the
    // app degrades rather than throwing when it has not, so this does the
    // same: the cost still lands in its pot, just unassigned, and says so.
    let unlinked = false;
    if (error && draft.projectId) {
      ({ error } = await supabase.from("budget_items").insert(row));
      unlinked = !error;
    }

    if (error) {
      setAddError("Could not add this cost: " + error.message);
      setCommitting(false);
      return;
    }

    if (unlinked) {
      setAddError(
        "Added to the pot, but not linked to the project. Migration 005 has not been run against this database."
      );
    }

    lastProjectId.current = draft.projectId;
    setReceipt({
      costId: cost.id,
      amount: alloc.amount,
      potName: pot?.name ?? "pot",
      projectName: unlinked ? null : project?.name ?? null,
      isEstimate: alloc.isEstimate,
    });
    setAddingId(null);
    setDraft(null);
    setCommitting(false);
    onAdded();
  }

  /**
   * Rename a category across every rate inside it.
   *
   * Categories are the names a practice uses for its own work, so
   * they have to be editable in one move rather than row by row.
   * Renaming onto a name that already exists merges the two, which is
   * usually what someone means by it — but it is destructive of the
   * distinction, so it is confirmed rather than assumed.
   */
  async function renameCategory(from: string, raw: string) {
    setRenamingCategory(null);
    const to = raw.trim();
    if (!to || to === from) return;

    const moving = costs.filter((c) => c.category === from).length;
    const merging = costs.some((c) => c.category === to);
    if (
      merging &&
      !window.confirm(
        `"${to}" already exists. Renaming moves these ${moving} rate${
          moving === 1 ? "" : "s"
        } into it, and the two categories become one.`
      )
    ) {
      return;
    }

    setPanelError("");
    await flushPending();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setPanelError("Not signed in.");
      return;
    }

    // Optimistic: the regroup is instant, the write catches up.
    setCosts((prev) =>
      prev.map((c) => (c.category === from ? { ...c, category: to } : c))
    );

    const { error } = await supabase
      .from("budget_production_costs")
      .update({ category: to })
      .eq("category", from)
      .eq("user_id", user.id);

    if (error) {
      setPanelError("Could not rename that category: " + error.message);
      void fetchCosts();
    }
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
          Your rates, under whatever names you use for your own work. Click a
          category to rename it; every rate inside moves with it. The order
          costing tool reads this card, and <strong>+ Add</strong> puts a single
          rate straight into a pot, on a project if you pick one.
        </div>

        {panelError && <div className="cost-add-warning">{panelError}</div>}

        {loading && <div className="loading">Loading...</div>}

        {!loading && costs.length === 0 && (
          <p className="blocks-empty">
            Your rate card is empty, which is where everyone starts. Add a
            category below and name it after the work you actually do — or apply
            a block, if you have one saved.
          </p>
        )}

        {/* Existing names, so moving one rate to another category autocompletes
            rather than inviting a near-miss that silently makes a new group. */}
        <datalist id="rate-card-categories">
          {Object.keys(grouped).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        {!loading &&
          Object.entries(grouped).map(([category, rows]) => (
            <div key={category} className="cost-group">
              {renamingCategory === category ? (
                <input
                  className="cost-group-title-edit"
                  autoFocus
                  defaultValue={category}
                  aria-label={`Rename the ${category} category`}
                  onBlur={(e) => void renameCategory(category, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setRenamingCategory(null);
                    }
                  }}
                />
              ) : (
                <button
                  className="cost-group-title"
                  onClick={() => setRenamingCategory(category)}
                  title="Rename this category"
                >
                  {category}
                  <span className="cost-group-count">
                    {rows.length} rate{rows.length === 1 ? "" : "s"}
                  </span>
                </button>
              )}
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
                        list="rate-card-categories"
                        placeholder="Category"
                        title="Move just this rate to another category"
                        value={cost.category}
                        onChange={(e) => updateLocal(cost.id, { category: e.target.value })}
                        onBlur={() => void flushPending()}
                      />
                      <span className="cost-mid">midpoint: {fmt((Number(cost.cost_low) + Number(cost.cost_high)) / 2)}</span>
                      <button
                        className="cost-add-btn"
                        onClick={() =>
                          addingId === cost.id ? cancelAdd() : openAdd(cost)
                        }
                        disabled={pots.length === 0}
                        title={
                          pots.length === 0
                            ? "Create a pot first — every cost has to land in one"
                            : "Put this rate into a pot, and optionally onto a project"
                        }
                      >
                        {addingId === cost.id ? "Close" : "+ Add"}
                      </button>
                    </div>

                    {addingId === cost.id && draft && (
                      <div className="cost-add-strip">
                        <div className="cost-add-points">
                          {POINT_ORDER.map((p) => {
                            const preview = allocateFromRate(cost, {
                              point: p,
                              quantity: draft.quantity,
                            });
                            return (
                              <button
                                key={p}
                                className={`cost-add-point${
                                  draft.point === p ? " is-selected" : ""
                                }`}
                                onClick={() => setDraft({ ...draft, point: p })}
                              >
                                <span>{POINT_LABELS[p]}</span>
                                <strong>{fmt(preview.amount)}</strong>
                              </button>
                            );
                          })}
                        </div>

                        <div className="cost-add-fields">
                          <label className="cost-add-field">
                            <span>Qty</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={draft.quantity}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  quantity: parseInt(e.target.value, 10) || 1,
                                })
                              }
                            />
                          </label>

                          <label className="cost-add-field">
                            <span>Pot</span>
                            <select
                              value={draft.potId}
                              onChange={(e) =>
                                setDraft({ ...draft, potId: e.target.value })
                              }
                            >
                              {pots.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </label>

                          {assignableProjects.length > 0 && (
                            <label className="cost-add-field">
                              <span>Project</span>
                              <select
                                value={draft.projectId ?? ""}
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    projectId: e.target.value || null,
                                  })
                                }
                              >
                                <option value="">— No project —</option>
                                {assignableProjects.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>

                        {(() => {
                          const alloc = allocateFromRate(cost, {
                            point: draft.point,
                            quantity: draft.quantity,
                          });
                          const potName =
                            pots.find((p) => p.id === draft.potId)?.name ?? "pot";
                          const projectName = assignableProjects.find(
                            (p) => p.id === draft.projectId
                          )?.name;
                          return (
                            <>
                              {alloc.warnings.map((w, i) => (
                                <div key={i} className="cost-add-warning">
                                  {w}
                                </div>
                              ))}
                              <div className="cost-add-actions">
                                <span className="cost-add-note">
                                  {alloc.isEstimate
                                    ? "Lands flagged as an estimate"
                                    : "A settled price, so not flagged as an estimate"}
                                </span>
                                <button
                                  className="draft-accept"
                                  disabled={alloc.amount <= 0 || !draft.potId || committing}
                                  onClick={() => confirmAdd(cost)}
                                >
                                  {committing
                                    ? "Adding..."
                                    : `Add ${fmt(alloc.amount)} to ${potName}${
                                        projectName ? ` · ${projectName}` : ""
                                      }`}
                                </button>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {receipt?.costId === cost.id && (
                      <div className="cost-add-receipt">
                        {fmt(receipt.amount)}
                        {receipt.isEstimate ? " (est.)" : ""} added to{" "}
                        <strong>{receipt.potName}</strong>
                        {receipt.projectName ? (
                          <>
                            {" "}
                            on <strong>{receipt.projectName}</strong>
                          </>
                        ) : null}
                        .
                      </div>
                    )}

                    {addError &&
                      (addingId === cost.id || receipt?.costId === cost.id) && (
                        <div className="cost-add-warning">{addError}</div>
                      )}
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

        {!loading && (
          <RateBlocks
            costs={costs}
            onBeforeAction={flushPending}
            onApplied={fetchCosts}
          />
        )}
      </div>
    </div>
  );
}
