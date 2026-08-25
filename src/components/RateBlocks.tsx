import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { fmt } from "../lib/format";
import { toBlockLines, summariseBlock, linesToInsert } from "../lib/rateblocks";
import type { ProductionCost, RateBlock } from "../lib/types";

interface RateBlocksProps {
  /** The current rate card, as loaded by the parent. */
  costs: ProductionCost[];
  /** Flush the parent's pending edits before we read or write. */
  onBeforeAction: () => Promise<void>;
  /** Refetch the rate card after a block has been applied. */
  onApplied: () => void;
}

const WHOLE_CARD = "__whole_card__";

export function RateBlocks({ costs, onBeforeAction, onApplied }: RateBlocksProps) {
  const [blocks, setBlocks] = useState<RateBlock[]>([]);
  /**
   * Null until we know. Migration 006 may not have been run, and the
   * rest of this app degrades rather than throwing when a table is
   * absent, so the whole section hides instead of erroring.
   */
  const [available, setAvailable] = useState<boolean | null>(null);

  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState<string>(WHOLE_CARD);
  const [blockName, setBlockName] = useState("");

  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyCategory, setApplyCategory] = useState("");
  const [collapseIntoOne, setCollapseIntoOne] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const c of costs) if (c.category && !seen.includes(c.category)) seen.push(c.category);
    return seen;
  }, [costs]);

  // The rows the current selection would save.
  const sourceRows = useMemo(
    () => (source === WHOLE_CARD ? costs : costs.filter((c) => c.category === source)),
    [costs, source]
  );
  const pendingLines = useMemo(() => toBlockLines(sourceRows), [sourceRows]);

  async function fetchBlocks() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error: fetchError } = await supabase
      .from("budget_rate_blocks")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    if (fetchError) {
      setAvailable(false);
      return;
    }
    setAvailable(true);
    setBlocks((data ?? []) as RateBlock[]);
  }

  useEffect(() => {
    void fetchBlocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetSave() {
    setSaving(false);
    setBlockName("");
    setSource(WHOLE_CARD);
  }

  async function saveBlock() {
    if (busy) return;
    const name = blockName.trim();
    if (!name) {
      setError("Give the block a name. It is also the category any unlabelled line lands under.");
      return;
    }
    if (pendingLines.length === 0) {
      setError("Nothing to save. Add at least one named rate first.");
      return;
    }

    setBusy(true);
    setError("");
    await onBeforeAction();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }

    const nextOrder = blocks.reduce((max, b) => Math.max(max, b.sort_order), 0) + 1;
    const { error: insertError } = await supabase.from("budget_rate_blocks").insert({
      user_id: user.id,
      name,
      lines: pendingLines,
      sort_order: nextOrder,
    });

    if (insertError) {
      setError("Could not save the block: " + insertError.message);
      setBusy(false);
      return;
    }

    setReceipt(
      `Saved "${name}" — ${pendingLines.length} line${pendingLines.length === 1 ? "" : "s"}.`
    );
    resetSave();
    setBusy(false);
    void fetchBlocks();
  }

  function openApply(block: RateBlock) {
    setError("");
    setReceipt("");
    setCollapseIntoOne(false);
    setApplyCategory(block.name);
    setApplyingId(block.id);
  }

  async function applyBlock(block: RateBlock) {
    if (busy) return;
    setBusy(true);
    setError("");
    await onBeforeAction();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }

    // Read the current maximum rather than trusting props, which may be
    // a beat behind an edit still settling in the parent.
    const { data: last } = await supabase
      .from("budget_production_costs")
      .select("sort_order")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    const rows = linesToInsert(block, {
      category: collapseIntoOne ? applyCategory : null,
      startSortOrder: Number(last?.sort_order ?? 0),
    }).map((row) => ({ ...row, user_id: user.id }));

    if (rows.length === 0) {
      setError("This block has no lines in it.");
      setBusy(false);
      return;
    }

    const { error: insertError } = await supabase
      .from("budget_production_costs")
      .insert(rows);

    if (insertError) {
      setError("Could not apply the block: " + insertError.message);
      setBusy(false);
      return;
    }

    setReceipt(`Added ${rows.length} line${rows.length === 1 ? "" : "s"} from "${block.name}".`);
    setApplyingId(null);
    setBusy(false);
    onApplied();
  }

  async function removeBlock(block: RateBlock) {
    if (
      !window.confirm(
        `Delete the block "${block.name}"? Rates already on your card stay exactly as they are.`
      )
    ) {
      return;
    }
    await supabase.from("budget_rate_blocks").delete().eq("id", block.id);
    setBlocks((prev) => prev.filter((b) => b.id !== block.id));
  }

  // Table absent, or we have not looked yet.
  if (available !== true) return null;

  return (
    <section className="blocks-section" aria-label="Rate blocks">
      <div className="blocks-header">
        <h3 className="blocks-title">Blocks</h3>
        <button
          className="add-btn"
          onClick={() => (saving ? resetSave() : setSaving(true))}
          disabled={costs.length === 0}
          title={
            costs.length === 0
              ? "Build a rate first, then you can keep it as a block"
              : "Keep part of this card as a reusable block"
          }
        >
          {saving ? "Cancel" : "Save as block"}
        </button>
      </div>

      <p className="blocks-description">
        A block is a set of rates you can lay down again later. Nothing ships with
        the app — every block here is one you kept.
      </p>

      {saving && (
        <div className="block-save">
          <label className="block-field">
            <span>Save</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value={WHOLE_CARD}>The whole rate card</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className="block-field block-field-grow">
            <span>As</span>
            <input
              autoFocus
              value={blockName}
              placeholder={source === WHOLE_CARD ? "e.g. Studio starting costs" : source}
              onChange={(e) => setBlockName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveBlock();
                if (e.key === "Escape") resetSave();
              }}
            />
          </label>

          <div className="block-save-actions">
            <span className="blocks-note">
              {pendingLines.length} line{pendingLines.length === 1 ? "" : "s"} will be kept
            </span>
            <button
              className="draft-accept"
              onClick={saveBlock}
              disabled={busy || pendingLines.length === 0}
            >
              {busy ? "Saving..." : "Save block"}
            </button>
          </div>
        </div>
      )}

      {blocks.length === 0 && !saving && (
        <p className="blocks-empty">
          No blocks yet. Build a category on your rate card, then keep it here to
          reuse on a future card.
        </p>
      )}

      {blocks.map((block) => {
        const summary = summariseBlock(block);
        const isApplying = applyingId === block.id;

        return (
          <article key={block.id} className="block-card">
            <div className="block-top">
              <span className="block-name">{block.name}</span>
              <span className="block-summary">
                {summary.lineCount} line{summary.lineCount === 1 ? "" : "s"} ·{" "}
                {fmt(summary.low)}–{fmt(summary.high)}
              </span>
              <button
                className="cost-add-btn"
                onClick={() => (isApplying ? setApplyingId(null) : openApply(block))}
              >
                {isApplying ? "Close" : "Apply"}
              </button>
              <button
                className="cost-delete"
                onClick={() => removeBlock(block)}
                aria-label={`Delete ${block.name}`}
              >
                ×
              </button>
            </div>

            <div className="block-categories">
              {summary.categories.join(" · ") || "No lines"}
            </div>

            {isApplying && (
              <div className="cost-add-strip">
                <label className="block-radio">
                  <input
                    type="radio"
                    checked={!collapseIntoOne}
                    onChange={() => setCollapseIntoOne(false)}
                  />
                  <span>
                    Keep its own categories
                    {summary.categories.length > 0 && ` (${summary.categories.join(", ")})`}
                  </span>
                </label>

                <label className="block-radio">
                  <input
                    type="radio"
                    checked={collapseIntoOne}
                    onChange={() => setCollapseIntoOne(true)}
                  />
                  <span>Put everything under one category</span>
                </label>

                {collapseIntoOne && (
                  <label className="block-field block-field-grow">
                    <span>Category</span>
                    <input
                      value={applyCategory}
                      onChange={(e) => setApplyCategory(e.target.value)}
                      placeholder={block.name}
                    />
                  </label>
                )}

                <div className="cost-add-actions">
                  <span className="cost-add-note">
                    Adds to your card. Nothing already there is changed or replaced.
                  </span>
                  <button
                    className="draft-accept"
                    onClick={() => applyBlock(block)}
                    disabled={busy || summary.lineCount === 0}
                  >
                    {busy
                      ? "Adding..."
                      : `Add ${summary.lineCount} line${summary.lineCount === 1 ? "" : "s"}`}
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}

      {error && <div className="cost-add-warning">{error}</div>}
      {receipt && !error && <div className="cost-add-receipt">{receipt}</div>}
    </section>
  );
}
