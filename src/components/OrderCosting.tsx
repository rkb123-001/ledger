import { useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { BudgetPot, CostingResult, CostedPiece } from "../lib/types";
import { fmt } from "../lib/format";

interface OrderCostingProps {
  pots: BudgetPot[];
  onCommitted: () => void;
}

type Stage = "idle" | "uploading" | "reviewing" | "saving";

export function OrderCosting({ pots, onCommitted }: OrderCostingProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<CostingResult | null>(null);
  const [editedPieces, setEditedPieces] = useState<CostedPiece[]>([]);
  const [marginMultiplier, setMarginMultiplier] = useState(4);
  const [clientName, setClientName] = useState("");
  const [orderRef, setOrderRef] = useState("");

  function reset() {
    setStage("idle");
    setError("");
    setResult(null);
    setEditedPieces([]);
    setMarginMultiplier(4);
    setClientName("");
    setOrderRef("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Catalogue sync. Kept here because this is the only screen where a stale
  // catalogue actually changes what you see.
  async function syncCatalogue() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const res = await fetch(`${supabaseUrl}/functions/v1/sync-catalogue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
      });
      const body = await res.json();
      if (!res.ok) {
        setSyncNote(body.hint ?? body.detail ?? body.error ?? "Sync failed");
        return;
      }
      setSyncNote(
        body.synced
          ? `Synced ${body.synced} variants across ${body.products} products.`
          : body.note ?? "Nothing to sync."
      );
    } catch (err) {
      setSyncNote(String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleFile(file: File) {
    setError("");
    setStage("uploading");

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const response = await fetch(`${supabaseUrl}/functions/v1/cost-order`, {
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

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Costing failed");

      setResult(data);
      setEditedPieces(data.pieces ?? []);
      setMarginMultiplier(data.margin_multiplier ?? 4);
      setClientName(data.client_name ?? "");
      setOrderRef(data.order_reference ?? "");
      setStage("reviewing");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("idle");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Recalculate totals from edited pieces
  function calcSubtotal(pieces: CostedPiece[]): number {
    return pieces.reduce((sum: number, piece: CostedPiece) => {
      const pieceTotal = piece.breakdown.reduce(
        (s: number, b) => s + Number(b.amount),
        0
      );
      return sum + pieceTotal * piece.quantity;
    }, 0);
  }

  const productionSubtotal = calcSubtotal(editedPieces);
  const suggestedRetail = Math.ceil((productionSubtotal * marginMultiplier) / 5) * 5;

  // Listed totals are derived here rather than trusted from the model, so they
  // stay correct when quantities are edited in the review panel.
  const matchedPieces = editedPieces.filter((p) => p.catalogue_match);
  const listedTotal = matchedPieces.length
    ? matchedPieces.reduce(
        (sum, p) => sum + (p.catalogue_match?.listed_price ?? 0) * (p.quantity || 1),
        0
      )
    : null;
  const marginOnListed =
    listedTotal && productionSubtotal > 0 ? listedTotal / productionSubtotal : null;
  const allPiecesMatched =
    editedPieces.length > 0 && matchedPieces.length === editedPieces.length;

  function updatePiece(pieceIdx: number, patch: Partial<CostedPiece>) {
    setEditedPieces((prev) => prev.map((p, i) => (i === pieceIdx ? { ...p, ...patch } : p)));
  }

  function updateBreakdownLine(pieceIdx: number, lineIdx: number, patch: Partial<{ description: string; amount: number; pot_name: string | null }>) {
    setEditedPieces((prev) =>
      prev.map((p, i) =>
        i === pieceIdx
          ? { ...p, breakdown: p.breakdown.map((b, j: number) => (j === lineIdx ? { ...b, ...patch } : b)) }
          : p
      )
    );
  }

  function deleteBreakdownLine(pieceIdx: number, lineIdx: number) {
    setEditedPieces((prev) =>
      prev.map((p, i) =>
        i === pieceIdx
          ? { ...p, breakdown: p.breakdown.filter((_, j: number) => j !== lineIdx) }
          : p
      )
    );
  }

  function addBreakdownLine(pieceIdx: number) {
    setEditedPieces((prev) =>
      prev.map((p, i) =>
        i === pieceIdx
          ? {
              ...p,
              breakdown: [
                ...p.breakdown,
                { description: "New cost", amount: 0, pot_name: null, is_estimate: true },
              ],
            }
          : p
      )
    );
  }

  function deletePiece(pieceIdx: number) {
    setEditedPieces((prev) => prev.filter((_, i) => i !== pieceIdx));
  }

  async function saveAsQuote() {
    setStage("saving");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in");
      setStage("reviewing");
      return;
    }

    const { error: insertError } = await supabase.from("budget_order_quotes").insert({
      user_id: user.id,
      client_name: clientName || null,
      order_reference: orderRef || null,
      pieces: editedPieces,
      production_subtotal: productionSubtotal,
      suggested_retail: suggestedRetail,
      margin_multiplier: marginMultiplier,
      status: "saved",
      committed_to_pots: false,
    });

    if (insertError) {
      setError("Could not save quote: " + insertError.message);
      setStage("reviewing");
      return;
    }

    reset();
    onCommitted();
  }

  async function commitToPots() {
    setStage("saving");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in");
      setStage("reviewing");
      return;
    }

    // Build draft items from each breakdown line
    const drafts = [];
    for (const piece of editedPieces) {
      for (const line of piece.breakdown) {
        const totalForLine = Number(line.amount) * piece.quantity;
        if (totalForLine <= 0) continue;

        const matchingPot = pots.find(
          (p) => p.name.toLowerCase() === line.pot_name?.toLowerCase()
        );

        const labelPrefix = clientName || orderRef || "Order";
        const qtyText = piece.quantity > 1 ? ` x${piece.quantity}` : "";
        drafts.push({
          user_id: user.id,
          suggested_pot_id: matchingPot?.id ?? null,
          suggested_pot_name: line.pot_name ?? "Other",
          label: `${labelPrefix}: ${piece.name}${qtyText} — ${line.description} (est.)`,
          amount: totalForLine,
          is_estimate: true,
          status: "pending",
        });
      }
    }

    if (drafts.length === 0) {
      setError("Nothing to commit");
      setStage("reviewing");
      return;
    }

    const { error: draftError } = await supabase.from("budget_drafts").insert(drafts);
    if (draftError) {
      setError("Could not create drafts: " + draftError.message);
      setStage("reviewing");
      return;
    }

    // Also save the quote with committed flag
    await supabase.from("budget_order_quotes").insert({
      user_id: user.id,
      client_name: clientName || null,
      order_reference: orderRef || null,
      pieces: editedPieces,
      production_subtotal: productionSubtotal,
      suggested_retail: suggestedRetail,
      margin_multiplier: marginMultiplier,
      status: "committed",
      committed_to_pots: true,
    });

    reset();
    onCommitted();
  }

  if (stage === "idle") {
    return (
      <div className="upload-section" style={{ background: "var(--info-bg)", border: "0.5px solid var(--info-text)" }}>
        <div className="upload-title" style={{ color: "var(--info-text)" }}>Cost a new order</div>
        <div className="upload-description">
          Upload a screenshot of a client order, brief, or specification. The app will estimate production costs piece-by-piece using your rate card, plus a suggested retail price.
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png, image/jpeg, image/webp, image/heic, image/heif"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <button
          className="upload-button"
          onClick={() => fileInputRef.current?.click()}
        >
          Upload order screenshot
        </button>
        <button
          className="upload-button secondary"
          onClick={syncCatalogue}
          disabled={syncing}
          style={{ marginTop: 8 }}
        >
          {syncing ? "Syncing catalogue…" : "Sync catalogue from Shopify"}
        </button>
        {syncNote && <div className="upload-status">{syncNote}</div>}
        {error && <div className="upload-status upload-error">{error}</div>}
      </div>
    );
  }

  if (stage === "uploading") {
    return (
      <div className="upload-section">
        <div className="upload-title">Costing the order...</div>
        <div className="upload-description">Reading the screenshot and looking up rates.</div>
      </div>
    );
  }

  if (stage === "saving") {
    return (
      <div className="upload-section">
        <div className="upload-title">Saving...</div>
      </div>
    );
  }

  // stage === "reviewing"
  return (
    <div className="costing-review">
      <div className="costing-header">
        <h2>Order costing review</h2>
        <button className="settings-close" onClick={reset}>×</button>
      </div>

      <div className="costing-meta">
        <div className="costing-meta-row">
          <label>Client</label>
          <input
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Client name"
          />
        </div>
        <div className="costing-meta-row">
          <label>Order ref</label>
          <input
            value={orderRef}
            onChange={(e) => setOrderRef(e.target.value)}
            placeholder="e.g. 0440"
          />
        </div>
      </div>

      {result?.warnings && result.warnings.length > 0 && (
        <div className="costing-warnings">
          <strong>Things to double-check:</strong>
          <ul>
            {result.warnings.map((w: string, i: number) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {editedPieces.map((piece, pi) => {
        const pieceTotal = piece.breakdown.reduce(
          (s: number, b) => s + Number(b.amount),
          0
        );
        const lineTotal = pieceTotal * piece.quantity;
        const match = piece.catalogue_match;
        return (
          <div key={pi} className="costing-piece">
            {match && (
              <div className={`catalogue-match confidence-${match.confidence}`}>
                <span className="catalogue-match-label">
                  Listed piece{match.confidence !== "exact" ? ` · ${match.confidence} match` : ""}
                </span>
                <span className="catalogue-match-title">
                  {match.title}
                  {match.variant_title ? ` · ${match.variant_title}` : ""}
                </span>
                <span className="catalogue-match-price">{fmt(match.listed_price)}</span>
              </div>
            )}
            <div className="costing-piece-header">
              <input
                className="costing-piece-name"
                value={piece.name}
                onChange={(e) => updatePiece(pi, { name: e.target.value })}
              />
              <div className="costing-piece-qty">
                <label>Qty</label>
                <input
                  type="number"
                  min="1"
                  value={piece.quantity}
                  onChange={(e) =>
                    updatePiece(pi, { quantity: parseInt(e.target.value) || 1 })
                  }
                />
              </div>
              <button className="cost-delete" onClick={() => deletePiece(pi)}>×</button>
            </div>
            {piece.notes && (
              <div className="costing-piece-notes">
                <input
                  value={piece.notes}
                  onChange={(e) => updatePiece(pi, { notes: e.target.value })}
                  placeholder="Notes about this piece"
                />
              </div>
            )}
            {piece.breakdown.map((line, li: number) => (
              <div key={li} className="costing-line">
                <input
                  className="costing-line-desc"
                  value={line.description}
                  onChange={(e) =>
                    updateBreakdownLine(pi, li, { description: e.target.value })
                  }
                />
                <select
                  className="costing-line-pot"
                  value={line.pot_name ?? ""}
                  onChange={(e) =>
                    updateBreakdownLine(pi, li, { pot_name: e.target.value || null })
                  }
                >
                  <option value="">— No pot —</option>
                  {pots.map((p) => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
                <input
                  className="costing-line-amount"
                  type="number"
                  step="0.01"
                  value={line.amount}
                  onChange={(e) =>
                    updateBreakdownLine(pi, li, { amount: parseFloat(e.target.value) || 0 })
                  }
                />
                <button
                  className="cost-delete"
                  onClick={() => deleteBreakdownLine(pi, li)}
                >×</button>
              </div>
            ))}
            <button className="add-btn" onClick={() => addBreakdownLine(pi)}>+ Add cost line</button>
            <div className="costing-piece-total">
              <span>Per piece: {fmt(pieceTotal)}</span>
              {piece.quantity > 1 && (
                <span>× {piece.quantity} = <strong>{fmt(lineTotal)}</strong></span>
              )}
            </div>
          </div>
        );
      })}

      <div className="costing-summary">
        <div className="costing-summary-row">
          <span>Production subtotal</span>
          <strong>{fmt(productionSubtotal)}</strong>
        </div>
        <div className="costing-summary-row">
          <label>Margin multiplier</label>
          <input
            type="number"
            step="0.5"
            min="1"
            value={marginMultiplier}
            onChange={(e) => setMarginMultiplier(parseFloat(e.target.value) || 1)}
            style={{ width: 60, textAlign: "right" }}
          />
        </div>
        <div className="costing-summary-row" style={{ fontSize: 18 }}>
          <span>{listedTotal === null ? "Suggested retail" : "Suggested retail (from costs)"}</span>
          <strong style={{ color: "var(--success-text)" }}>{fmt(suggestedRetail)}</strong>
        </div>
      </div>

      {listedTotal !== null && (
        <div className="costing-summary" style={{ marginTop: 12 }}>
          <div className="costing-summary-row">
            <span>
              {allPiecesMatched ? "Listed price" : "Listed price (matched pieces)"}
            </span>
            <strong>{fmt(listedTotal)}</strong>
          </div>
          <div className="costing-summary-row">
            <span>Margin on listed price</span>
            <strong
              style={{
                color:
                  marginOnListed && marginOnListed < 3
                    ? "var(--danger-text)"
                    : "var(--success-text)",
              }}
            >
              {marginOnListed ? `${marginOnListed.toFixed(2)}×` : "—"}
            </strong>
          </div>
          {marginOnListed !== null && marginOnListed < 3 && (
            <div className="costing-summary-note">
              This piece is published at {fmt(listedTotal)} and now costs {fmt(productionSubtotal)}
              {" "}to build. That is a {marginOnListed.toFixed(2)}× margin, below your 3× floor.
              Worth reviewing the listed price.
            </div>
          )}
          {!allPiecesMatched && (
            <div className="costing-summary-note">
              Only {matchedPieces.length} of {editedPieces.length} pieces matched the
              catalogue. The rest are priced from the rate card.
            </div>
          )}
          {allPiecesMatched && marginOnListed !== null && marginOnListed >= 3 && (
            <div className="costing-summary-note">
              Charge the listed {fmt(listedTotal)}. At {marginOnListed.toFixed(2)}× it is
              still healthy, so there is no reason to depart from the published price.
              {suggestedRetail > listedTotal
                ? ` Costing from scratch today would suggest ${fmt(suggestedRetail)}, worth noting if this piece comes up often.`
                : ""}
            </div>
          )}
        </div>
      )}

      {error && <div className="upload-status upload-error">{error}</div>}

      <div className="costing-actions">
        <button className="draft-reject" onClick={reset}>Cancel</button>
        <button className="draft-reject" onClick={saveAsQuote}>Save quote only</button>
        <button className="draft-accept" onClick={commitToPots}>Add to pots as drafts</button>
      </div>
    </div>
  );
}
