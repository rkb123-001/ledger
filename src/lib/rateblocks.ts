/**
 * Rate blocks.
 *
 * A block is a named, reusable set of rate card lines — the costs of
 * one kind of work, kept so they can be laid down again without being
 * retyped. Blocks are how a practice defines its own starting point
 * instead of inheriting someone else's.
 *
 * Two conversions live here, and both are pure:
 *
 *   rate card rows  -> block lines   (toBlockLines)
 *   block lines     -> rate card rows (linesToInsert)
 *
 * They are separated from the component because both are lossy in
 * ways that matter. Saving strips identity: a block is a recipe, not
 * a copy of rows, so ids and ownership are deliberately dropped and
 * the block survives the rows it came from being edited or deleted.
 * Applying has to invent what the block does not carry — a category
 * for a line that has none, a sort order that appends rather than
 * collides. Getting either wrong corrupts a rate card quietly, which
 * is the same reason the costing maths sits in predict.ts rather than
 * in a click handler. See rateblocks.test.ts.
 */

/** One line of a block. No id: a block is a recipe, not a row. */
export interface RateBlockLine {
  description: string;
  cost_low: number;
  cost_high: number;
  pot_name: string | null;
  notes: string | null;
  /** Where this line came from. Null means it takes the block's name. */
  category: string | null;
}

export interface RateBlockSummary {
  lineCount: number;
  /** Distinct categories the block will create, in first-seen order. */
  categories: string[];
  /** Summed low and high across every line. */
  low: number;
  high: number;
}

/** The shape written to budget_production_costs when a block is applied. */
export interface RateCardInsert {
  category: string;
  description: string;
  cost_low: number;
  cost_high: number;
  pot_name: string | null;
  notes: string | null;
  sort_order: number;
}

export interface ApplyOptions {
  /** Put every line under this category instead of its own. */
  category?: string | null;
  /** Highest sort_order already on the card. New lines follow it. */
  startSortOrder?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function orNull(value: unknown): string | null {
  const text = trimmed(value);
  return text === "" ? null : text;
}

/** Low and high, in the right order, whichever way round they arrived. */
function orderedRange(low: unknown, high: unknown): { low: number; high: number } {
  const a = safeNumber(low);
  const b = safeNumber(high);
  return { low: round2(Math.min(a, b)), high: round2(Math.max(a, b)) };
}

/**
 * Turn rate card rows into block lines.
 *
 * Rows with no description are dropped rather than kept as blanks: a
 * nameless rate cannot be applied usefully, and a block full of
 * "Untitled" is worse than a shorter honest one.
 */
export function toBlockLines(
  rows: ReadonlyArray<{
    category?: unknown;
    description?: unknown;
    cost_low?: unknown;
    cost_high?: unknown;
    pot_name?: unknown;
    notes?: unknown;
  }> | null | undefined
): RateBlockLine[] {
  const lines: RateBlockLine[] = [];

  for (const row of rows ?? []) {
    const description = trimmed(row?.description);
    if (!description) continue;

    const range = orderedRange(row?.cost_low, row?.cost_high);
    lines.push({
      description,
      cost_low: range.low,
      cost_high: range.high,
      pot_name: orNull(row?.pot_name),
      notes: orNull(row?.notes),
      category: orNull(row?.category),
    });
  }

  return lines;
}

/**
 * What a block will produce, for showing before it is applied.
 *
 * The category list resolves the same way applying does, so what is
 * previewed is what lands.
 */
export function summariseBlock(block: {
  name?: unknown;
  lines?: ReadonlyArray<RateBlockLine> | null;
}): RateBlockSummary {
  const fallback = trimmed(block?.name) || "Uncategorised";
  const lines = block?.lines ?? [];

  const categories: string[] = [];
  let low = 0;
  let high = 0;

  for (const line of lines) {
    const category = orNull(line?.category) ?? fallback;
    if (!categories.includes(category)) categories.push(category);
    low += safeNumber(line?.cost_low);
    high += safeNumber(line?.cost_high);
  }

  return {
    lineCount: lines.length,
    categories,
    low: round2(low),
    high: round2(high),
  };
}

/**
 * The rows to insert when a block is applied.
 *
 * Category resolution runs in one order and never falls through to
 * nothing: an explicit override, then the line's own stored category,
 * then the block's name. A line cannot land uncategorised, because the
 * rate card groups by category and a blank one would make the row
 * effectively invisible.
 *
 * Sort orders continue from the card's current maximum, so applying a
 * block appends rather than interleaving with what is already there.
 */
export function linesToInsert(
  block: { name?: unknown; lines?: ReadonlyArray<RateBlockLine> | null },
  opts: ApplyOptions = {}
): RateCardInsert[] {
  const override = trimmed(opts.category);
  const fallback = trimmed(block?.name) || "Uncategorised";
  const start = safeNumber(opts.startSortOrder);

  return (block?.lines ?? []).map((line, index) => {
    const range = orderedRange(line?.cost_low, line?.cost_high);
    return {
      category: override || orNull(line?.category) || fallback,
      description: trimmed(line?.description) || "Untitled rate",
      cost_low: range.low,
      cost_high: range.high,
      pot_name: orNull(line?.pot_name),
      notes: orNull(line?.notes),
      sort_order: start + index + 1,
    };
  });
}
