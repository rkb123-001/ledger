// Saved quotes, and the close-out that makes prediction possible.
//
// budget_order_quotes was write-only until this existed: quotes saved, nothing
// read them back, and actual_production_cost was never set. Since
// budget_prediction_factor learns from exactly that column, the factor was
// pinned at 1.0 no matter how many jobs went through. This panel is the missing
// return path.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { OrderQuote, BudgetPot, CostedPiece } from "../lib/types";
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editClient, setEditClient] = useState("");
  const [editRef, setEditRef] = useState("");
  const [editPieces, setEditPieces] = useState<CostedPiece[]>([]);
  const [costDraft, setCostDraft] = useState("");
  const [hoursDraft, setHoursDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  // Set while a hand-written quote is being typed for the first time. Cancelling
  // that edit removes the row, so an abandoned "New quote" leaves nothing behind.
  const [unsavedNewId, setUnsavedNewId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("ledger.quotes.collapsed") === "1";
    } catch {
      return false;
    }
  });
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

  function startEdit(q: Row) {
    setUnsavedNewId(null);
    setEditingId(q.id);
    setExpandedId(q.id);
    setEditClient(q.client_name ?? "");
    setEditRef(q.order_reference ?? "");
    // Deep copy, so abandoning an edit leaves the saved quote untouched.
    setEditPieces(JSON.parse(JSON.stringify(q.pieces ?? [])));
  }

  function patchLine(pi: number, li: number, patch: Record<string, unknown>) {
    setEditPieces((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as CostedPiece[];
      next[pi].breakdown[li] = { ...next[pi].breakdown[li], ...patch };
      return next;
    });
  }

  function patchPiece(pi: number, patch: Record<string, unknown>) {
    setEditPieces((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as CostedPiece[];
      next[pi] = { ...next[pi], ...patch };
      return next;
    });
  }

  function addPiece() {
    setEditPieces((prev) => [
      ...prev,
      {
        name: "New piece",
        quantity: 1,
        notes: "",
        breakdown: [{ description: "", amount: 0, pot_name: null, is_estimate: true }],
        production_cost: 0,
      },
    ]);
  }

  function addLine(pi: number) {
    setEditPieces((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as CostedPiece[];
      next[pi].breakdown = [
        ...(next[pi].breakdown ?? []),
        { description: "", amount: 0, pot_name: null, is_estimate: true },
      ];
      return next;
    });
  }

  function removePiece(pi: number) {
    setEditPieces((prev) => prev.filter((_, i) => i !== pi));
  }

  // A quote costed from a screenshot, without going through the intake panel.
  // The enquiry usually arrives as a DM or an email on the phone, where a
  // screenshot is the only practical way to get it into the app.
  //
  // The costed quote is saved first and opened in the editor, rather than
  // reviewed in a second screen: everything needed to check it is already in
  // this editor, and Cancel discards it, so nothing is kept unless confirmed.
  async function quoteFromImage(file: File) {
    setBusy(true);
    setError(null);
    setNote("Reading the screenshot\u2026");

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");

      setNote("Costing the order\u2026");
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const res = await fetch(`${supabaseUrl}/functions/v1/cost-order`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: base64,
          mediaType: file.type || "image/png",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Costing failed");

      const pieces: CostedPiece[] = data.pieces ?? [];
      if (pieces.length === 0) {
        throw new Error("Nothing costable was found in that screenshot");
      }

      // Totals are recomputed here rather than trusted from the model, the same
      // rule the costing panel follows.
      const subtotal = pieces.reduce(
        (sum, p) =>
          sum +
          (p.breakdown ?? []).reduce((s, l) => s + Number(l.amount || 0), 0) *
            (p.quantity || 1),
        0
      );
      const multiplier = Number(data.margin_multiplier ?? 4);
      const retail = Math.ceil((subtotal * multiplier) / 5) * 5;

      const { data: row, error: err } = await supabase
        .from("budget_order_quotes")
        .insert({
          user_id: userId,
          client_name: data.client_name || null,
          order_reference: data.order_reference || null,
          pieces,
          production_subtotal: subtotal,
          suggested_retail: retail,
          margin_multiplier: multiplier,
          status: "saved",
          committed_to_pots: false,
        })
        .select()
        .single();

      if (err || !row) throw new Error(err?.message ?? "Could not save the quote");

      setCollapsed(false);
      await fetchQuotes();
      const saved = row as Row;
      startEdit(saved);
      setUnsavedNewId(saved.id);
      setNote(
        `Costed ${pieces.length} ${pieces.length === 1 ? "piece" : "pieces"}. Check it, then save.`
      );
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNote(null);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // A quote written by hand, for work that never arrived as an email to cost.
  // It is created empty and opened straight in the editor, so there is only one
  // place in the app where a quote's lines get typed.
  async function createBlankQuote() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("budget_order_quotes")
      .insert({
        user_id: userId,
        client_name: null,
        order_reference: null,
        pieces: [],
        production_subtotal: 0,
        suggested_retail: null,
        margin_multiplier: 4,
        status: "saved",
        committed_to_pots: false,
      })
      .select()
      .single();
    setBusy(false);

    if (err || !data) {
      setError(err?.message ?? "Could not create the quote");
      return;
    }

    setCollapsed(false);
    await fetchQuotes();
    const row = data as Row;
    setUnsavedNewId(row.id);
    setEditingId(row.id);
    setExpandedId(row.id);
    setEditClient("");
    setEditRef("");
    setEditPieces([
      {
        name: "New piece",
        quantity: 1,
        notes: "",
        breakdown: [{ description: "", amount: 0, pot_name: null, is_estimate: true }],
        production_cost: 0,
      },
    ]);
  }

  function removeLine(pi: number, li: number) {
    setEditPieces((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as CostedPiece[];
      next[pi].breakdown.splice(li, 1);
      return next;
    });
  }

  const editSubtotal = editPieces.reduce(
    (sum, p) =>
      sum +
      (p.breakdown ?? []).reduce((s, l) => s + Number(l.amount || 0), 0) *
        (p.quantity || 1),
    0
  );

  async function saveEdit(q: Row) {
    setBusy(true);
    // production_cost per piece is stored alongside the breakdown, so it has to
    // be recomputed here or the two disagree the moment a line changes.
    const pieces = editPieces.map((p) => ({
      ...p,
      production_cost: (p.breakdown ?? []).reduce(
        (s, l) => s + Number(l.amount || 0),
        0
      ),
    }));
    const subtotal = pieces.reduce(
      (sum, p) => sum + Number(p.production_cost) * (p.quantity || 1),
      0
    );
    const retail =
      Math.ceil((subtotal * Number(q.margin_multiplier || 4)) / 5) * 5;

    const { error: err } = await supabase
      .from("budget_order_quotes")
      .update({
        client_name: editClient || null,
        order_reference: editRef || null,
        pieces,
        production_subtotal: subtotal,
        suggested_retail: retail,
      })
      .eq("id", q.id)
      .eq("user_id", userId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setEditingId(null);
    setUnsavedNewId(null);
    setError(null);
    setNote(null);
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

  // Cancelling a normal edit just closes the editor. Cancelling the first edit
  // of a hand-written quote deletes the row it was created against, because
  // nothing has been typed into it worth keeping.
  async function cancelEdit(q: Row) {
    setEditingId(null);
    setNote(null);
    if (unsavedNewId !== q.id) return;

    setUnsavedNewId(null);
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
            {editingId === q.id ? (
              <>
                <div className="quote-edit-meta">
                  <label>
                    Client
                    <input
                      value={editClient}
                      onChange={(e) => setEditClient(e.target.value)}
                      placeholder="Client name"
                    />
                  </label>
                  <label>
                    Order ref
                    <input
                      value={editRef}
                      onChange={(e) => setEditRef(e.target.value)}
                      placeholder="e.g. 0448"
                    />
                  </label>
                </div>

                {editPieces.map((piece, pi) => (
                  <div key={pi} className="quote-piece">
                    <div className="quote-edit-piece-header">
                      <input
                        className="quote-edit-name"
                        value={piece.name}
                        onChange={(e) => patchPiece(pi, { name: e.target.value })}
                      />
                      <label className="quote-edit-qty">
                        Qty
                        <input
                          type="number"
                          min="1"
                          value={piece.quantity || 1}
                          onChange={(e) =>
                            patchPiece(pi, {
                              quantity: parseInt(e.target.value) || 1,
                            })
                          }
                        />
                      </label>
                      <button
                        className="item-delete"
                        title="Remove piece"
                        onClick={() => removePiece(pi)}
                      >
                        \u00d7
                      </button>
                    </div>

                    {(piece.breakdown ?? []).map((line, li) => (
                      <div key={li} className="quote-line editing">
                        <input
                          value={line.description}
                          onChange={(e) =>
                            patchLine(pi, li, { description: e.target.value })
                          }
                        />
                        <select
                          value={line.pot_name ?? ""}
                          onChange={(e) =>
                            patchLine(pi, li, { pot_name: e.target.value || null })
                          }
                        >
                          <option value="">no pot</option>
                          {pots.map((p) => (
                            <option key={p.id} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <input
                          className="quote-line-amount-input"
                          inputMode="decimal"
                          value={String(line.amount ?? "")}
                          onChange={(e) =>
                            patchLine(pi, li, {
                              amount:
                                parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 0,
                            })
                          }
                        />
                        <button
                          className="item-delete"
                          title="Remove line"
                          onClick={() => removeLine(pi, li)}
                        >
                          ×
                        </button>
                      </div>
                    ))}

                    <button className="quote-add-line" onClick={() => addLine(pi)}>
                      + Add line
                    </button>
                  </div>
                ))}

                <button className="quote-add-piece" onClick={addPiece}>
                  + Add piece
                </button>

                <div className="quote-edit-total">
                  <span>Production subtotal</span>
                  <strong>{fmt(editSubtotal)}</strong>
                </div>

                {q.committed_to_pots && (
                  <div className="quote-committed-note">
                    This quote was already committed. Editing it does not change
                    the drafts or pot items it produced.
                  </div>
                )}

                <div className="quote-detail-actions">
                  <button
                    className="draft-reject"
                    onClick={() => { void cancelEdit(q); }}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    className="upload-button"
                    onClick={() => saveEdit(q)}
                    disabled={busy}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </>
            ) : (
              <>
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
                  <button className="draft-reject" onClick={() => startEdit(q)}>
                    Edit
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
              </>
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

  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem("ledger.quotes.collapsed", next ? "1" : "0");
      } catch {
        // Private browsing, or storage disabled. The toggle still works for this visit.
      }
      return next;
    });
  }

  if (quotes === null) return null;

  return (
    <div className="quotes-panel">
      <div className="quotes-header">
        <button
          type="button"
          className="panel-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? "Show quotes" : "Hide quotes"}
        >
          <span className="panel-caret" aria-hidden="true">
            {collapsed ? "\u25B8" : "\u25BE"}
          </span>
          <h2 className="quotes-title">Quotes</h2>
          {collapsed && open.length > 0 && (
            <span className="panel-count">{open.length}</span>
          )}
        </button>
        {!collapsed && (
          <div className="quotes-header-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void quoteFromImage(file);
              }}
            />
            <button
              className="add-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title="Cost a quote from a screenshot of the enquiry"
            >
              From screenshot
            </button>
            <button
              className="add-btn"
              onClick={createBlankQuote}
              disabled={busy}
              title="Write a quote by hand"
            >
              New quote
            </button>
          </div>
        )}
        {!collapsed && closed.length > 0 && (
          <button className="draft-reject" onClick={() => setShowClosed((s) => !s)}>
            {showClosed ? "Hide closed" : `Show closed (${closed.length})`}
          </button>
        )}
      </div>

      <div className="quotes-sub" hidden={collapsed}>
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

      {!collapsed && note && <div className="upload-status">{note}</div>}
      {!collapsed && error && <div className="upload-status upload-error">{error}</div>}

      {!collapsed && open.length === 0 && closed.length === 0 && (
        <div className="quotes-empty">
          No quotes yet. Cost one from a screenshot of the enquiry, or write one by hand.
        </div>
      )}

      {!collapsed && open.map(renderRow)}
      {!collapsed && showClosed && closed.map(renderRow)}
    </div>
  );
}
