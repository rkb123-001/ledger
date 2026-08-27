// Saved quotes, and the close-out that makes prediction possible.
//
// budget_order_quotes was write-only until this existed: quotes saved, nothing
// read them back, and actual_production_cost was never set. Since
// budget_prediction_factor learns from exactly that column, the factor was
// pinned at 1.0 no matter how many jobs went through. This panel is the missing
// return path.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { OrderQuote, BudgetPot } from "../lib/types";
import { fmt } from "../lib/format";

interface QuotesPanelProps {
  userId: string;
  pots: BudgetPot[];
  onChanged?: () => void;
}

type Row = OrderQuote & {
  actual_production_cost: number | null;
  quoted_hours: number | null;
  actual_hours: number | null;
  closed_at: string | null;
};

export function QuotesPanel({ userId, pots, onChanged }: QuotesPanelProps) {
  const [quotes, setQuotes] = useState<Row[] | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [costDraft, setCostDraft] = useState("");
  const [hoursDraft, setHoursDraft] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchQuotes = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("budget_order_quotes")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (err) {
      // Most likely migration 010 has not been run yet. Say so rather than
      // rendering an empty panel that looks like "you have no quotes".
      setError(err.message);
      setQuotes([]);
      return;
    }
    setError(null);
    setQuotes((data ?? []) as Row[]);
  }, [userId]);

  useEffect(() => {
    fetchQuotes();
  }, [fetchQuotes]);

  const open = useMemo(
    () => (quotes ?? []).filter((q) => q.actual_production_cost === null),
    [quotes]
  );
  const closed = useMemo(
    () => (quotes ?? []).filter((q) => q.actual_production_cost !== null),
    [quotes]
  );

  // Shown so the number on screen is never a mystery: this is what the
  // prediction factor is currently working from.
  const drift = useMemo(() => {
    const ratios = closed
      .map((q) =>
        q.production_subtotal > 0
          ? Number(q.actual_production_cost) / Number(q.production_subtotal)
          : null
      )
      .filter((r): r is number => r !== null && r >= 0.25 && r <= 4)
      .sort((a, b) => a - b);
    if (ratios.length === 0) return null;
    const mid = Math.floor(ratios.length / 2);
    const median =
      ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
    return { median, sample: ratios.length };
  }, [closed]);

  function startClose(q: Row) {
    setClosingId(q.id);
    setCostDraft(String(q.production_subtotal));
    setHoursDraft(q.quoted_hours ? String(q.quoted_hours) : "");
  }

  async function saveClose(q: Row) {
    const cost = parseFloat(costDraft);
    if (!Number.isFinite(cost) || cost < 0) {
      setError("Enter what the job actually cost.");
      return;
    }
    const hours = parseFloat(hoursDraft);
    setBusy(true);
    const { error: err } = await supabase
      .from("budget_order_quotes")
      .update({
        actual_production_cost: cost,
        actual_hours: Number.isFinite(hours) && hours >= 0 ? hours : null,
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", q.id)
      .eq("user_id", userId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setClosingId(null);
    setError(null);
    await fetchQuotes();
    onChanged?.();
  }

  // Same route as costing an order: line items become drafts in the review
  // queue rather than landing in pots directly. A model proposes, a person
  // confirms, and that rule does not get an exception just because the quote
  // was reviewed once already.
  async function commitToPots(q: Row) {
    const drafts: Record<string, unknown>[] = [];
    for (const piece of q.pieces ?? []) {
      for (const line of piece.breakdown ?? []) {
        const total = Number(line.amount) * (piece.quantity || 1);
        if (total <= 0) continue;
        const pot = pots.find(
          (p) => p.name.toLowerCase() === (line.pot_name ?? "").toLowerCase()
        );
        const prefix = q.client_name || q.order_reference || "Order";
        const qtyText = (piece.quantity || 1) > 1 ? ` x${piece.quantity}` : "";
        drafts.push({
          user_id: userId,
          suggested_pot_id: pot?.id ?? null,
          suggested_pot_name: line.pot_name ?? "Other",
          label: `${prefix}: ${piece.name}${qtyText} — ${line.description} (est.)`,
          amount: total,
          is_estimate: true,
          status: "pending",
        });
      }
    }

    if (drafts.length === 0) {
      setError("This quote has no cost lines to commit.");
      return;
    }

    setBusy(true);
    const { error: draftError } = await supabase.from("budget_drafts").insert(drafts);
    if (draftError) {
      setBusy(false);
      setError("Could not create drafts: " + draftError.message);
      return;
    }

    await supabase
      .from("budget_order_quotes")
      .update({ committed_to_pots: true, status: "committed" })
      .eq("id", q.id)
      .eq("user_id", userId);

    setBusy(false);
    setError(null);
    await fetchQuotes();
    onChanged?.();
  }

  async function deleteQuote(q: Row) {
    const who = q.client_name || q.order_reference || "this quote";
    if (
      !window.confirm(
        `Delete the quote for ${who}? Any drafts or pot items already created from it are left alone.`
      )
    )
      return;
    setBusy(true);
    const { error: err } = await supabase
      .from("budget_order_quotes")
      .delete()
      .eq("id", q.id)
      .eq("user_id", userId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    if (expandedId === q.id) setExpandedId(null);
    await fetchQuotes();
    onChanged?.();
  }

  async function reopen(q: Row) {
    if (!window.confirm(`Reopen the quote for ${q.client_name ?? "this job"}?`)) return;
    await supabase
      .from("budget_order_quotes")
      .update({
        actual_production_cost: null,
        actual_hours: null,
        status: "draft",
        closed_at: null,
      })
      .eq("id", q.id)
      .eq("user_id", userId);
    await fetchQuotes();
    onChanged?.();
  }

  function renderRow(q: Row) {
    const isClosing = closingId === q.id;
    const actual = q.actual_production_cost;
    const variance =
      actual !== null && q.production_subtotal > 0
        ? actual - Number(q.production_subtotal)
        : null;

    return (
      <div key={q.id} className={`quote-row${actual !== null ? " closed" : ""}`}>
        <button
          className="quote-main"
          onClick={() => setExpandedId((id) => (id === q.id ? null : q.id))}
          aria-expanded={expandedId === q.id}
        >
          <div className="quote-title">
            <span className="quote-caret">{expandedId === q.id ? "▾" : "▸"}</span>{" "}
            {q.client_name || "Unnamed"}
            {q.order_reference ? <span className="quote-ref"> · {q.order_reference}</span> : null}
          </div>
          <div className="quote-meta">
            {new Date(q.created_at).toLocaleDateString("en-GB")}
            {q.committed_to_pots ? " · committed to pots" : " · quote only"}
            {q.quoted_hours ? ` · ${q.quoted_hours}h quoted` : ""}
          </div>
        </button>

        <div className="quote-figures">
          <div className="quote-figure">
            <span className="quote-figure-label">Quoted</span>
            <span className="quote-figure-value">{fmt(Number(q.production_subtotal))}</span>
          </div>
          {q.suggested_retail !== null && (
            <div className="quote-figure">
              <span className="quote-figure-label">Retail</span>
              <span className="quote-figure-value">{fmt(Number(q.suggested_retail))}</span>
            </div>
          )}
          {actual !== null && (
            <div className="quote-figure">
              <span className="quote-figure-label">Actual</span>
              <span
                className="quote-figure-value"
                style={{
                  color:
                    variance && variance > 0 ? "var(--danger-text)" : "var(--success-text)",
                }}
              >
                {fmt(Number(actual))}
                {variance !== null && variance !== 0 && (
                  <span className="quote-variance">
                    {variance > 0 ? " +" : " "}
                    {fmt(variance)}
                  </span>
                )}
              </span>
            </div>
          )}
          {actual !== null && q.actual_hours !== null && (
            <div className="quote-figure">
              <span className="quote-figure-label">Hours</span>
              <span className="quote-figure-value">{q.actual_hours}h</span>
            </div>
          )}
        </div>

        <div className="quote-actions">
          {actual === null && !isClosing && (
            <button className="upload-button secondary" onClick={() => startClose(q)}>
              Close out
            </button>
          )}
          {actual !== null && (
            <button className="draft-reject" onClick={() => reopen(q)}>
              Reopen
            </button>
          )}
        </div>

        {expandedId === q.id && (
          <div className="quote-detail">
            {(q.pieces ?? []).map((piece, pi) => (
              <div key={pi} className="quote-piece">
                <div className="quote-piece-name">
                  {piece.name}
                  {(piece.quantity || 1) > 1 ? ` ×${piece.quantity}` : ""}
                </div>
                {(piece.breakdown ?? []).map((line, li) => (
                  <div key={li} className="quote-line">
                    <span>{line.description}</span>
                    <span className="quote-line-pot">{line.pot_name ?? "no pot"}</span>
                    <span className="quote-line-amount">{fmt(Number(line.amount))}</span>
                  </div>
                ))}
              </div>
            ))}

            {(q.pieces ?? []).length === 0 && (
              <div className="quote-line">No cost breakdown saved with this quote.</div>
            )}

            <div className="quote-detail-actions">
              <button
                className="draft-reject danger"
                onClick={() => deleteQuote(q)}
                disabled={busy}
              >
                Delete quote
              </button>
              {q.committed_to_pots ? (
                <span className="quote-committed-note">
                  Already committed. Committing again would double the costs.
                </span>
              ) : (
                <button
                  className="upload-button"
                  onClick={() => commitToPots(q)}
                  disabled={busy}
                >
                  {busy ? "Working…" : "Commit costs to pots"}
                </button>
              )}
            </div>

            {!q.committed_to_pots && (
              <div className="quote-committed-note">
                Lines go to the review queue as drafts, not straight into pots.
              </div>
            )}
          </div>
        )}

        {isClosing && (
          <div className="quote-close-form">
            <div className="quote-close-fields">
              <label>
                What it actually cost
                <input
                  type="text"
                  inputMode="decimal"
                  value={costDraft}
                  autoFocus
                  onChange={(e) => setCostDraft(e.target.value.replace(/[^0-9.]/g, ""))}
                />
              </label>
              <label>
                Hours it actually took
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="optional"
                  value={hoursDraft}
                  onChange={(e) => setHoursDraft(e.target.value.replace(/[^0-9.]/g, ""))}
                />
              </label>
            </div>
            <div className="quote-close-actions">
              <button className="draft-reject" onClick={() => setClosingId(null)}>
                Cancel
              </button>
              <button
                className="upload-button"
                disabled={busy}
                onClick={() => saveClose(q)}
              >
                {busy ? "Saving…" : "Save outturn"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (quotes === null) return null;

  return (
    <div className="quotes-panel">
      <div className="quotes-header">
        <h2 className="quotes-title">Quotes</h2>
        {closed.length > 0 && (
          <button className="draft-reject" onClick={() => setShowClosed((s) => !s)}>
            {showClosed ? "Hide closed" : `Show closed (${closed.length})`}
          </button>
        )}
      </div>

      <div className="quotes-sub">
        {drift
          ? `Estimates run ${drift.median.toFixed(2)}× actual over ${drift.sample} closed ${
              drift.sample === 1 ? "job" : "jobs"
            }. ${
              drift.sample < 3
                ? "Predictions stay uncorrected until three have closed."
                : drift.median > 1
                ? "New quotes are scaled up to match."
                : "New quotes are scaled down to match."
            }`
          : "Close a job with what it actually cost, and quotes start correcting themselves against your own history. Three closes before any correction is applied."}
      </div>

      {error && <div className="upload-status upload-error">{error}</div>}

      {open.length === 0 && closed.length === 0 && (
        <div className="quotes-empty">
          No quotes yet. Cost an order and choose Save quote only, or Add to pots as drafts.
        </div>
      )}

      {open.map(renderRow)}
      {showClosed && closed.map(renderRow)}
    </div>
  );
}
