/**
 * Costing prediction.
 *
 * The rate card stores every production input as a low/high range rather
 * than a single figure, because casting, plating and hallmarking prices
 * genuinely vary per job. A quote is therefore a range, not a number.
 *
 * Two things then happen to that range:
 *
 *   1. It is calibrated against history. Estimates drift in a consistent
 *      direction for a given maker, so the median ratio of actual to
 *      quoted cost across closed jobs is applied as a correction. That
 *      factor comes from budget_prediction_factor() in migration 005 and
 *      is 1.0 until at least three jobs have closed.
 *
 *   2. A margin multiplier is applied to reach a retail price.
 *
 * Everything here is pure: no React, no Supabase, no dates, no I/O.
 * That is deliberate. This is the part of the app where being wrong
 * costs real money, so it is the part that is directly testable.
 * See predict.test.ts.
 */

export interface CostRange {
  low: number;
  high: number;
}

/** A single costed input drawn from the production rate card. */
export interface RateCardLine {
  cost_low: number;
  cost_high: number;
  quantity?: number;
}

export type Confidence = "none" | "low" | "medium" | "high";

export interface CostPrediction {
  /** Uncalibrated sum of the rate card ranges. */
  raw: CostRange;
  /** After the historical calibration factor is applied. */
  calibrated: CostRange;
  /** Single figure to quote from: the midpoint of the calibrated range. */
  point: number;
  /** The factor that was applied. 1 means no correction was made. */
  factor: number;
  /** How much history that factor rests on. */
  confidence: Confidence;
}

export interface RetailSuggestion {
  productionCost: number;
  marginMultiplier: number;
  suggestedRetail: number;
  /** Cash margin at the suggested price. */
  grossMargin: number;
  warnings: string[];
}

/** Project figures as returned by the budget_project_rollup view. */
export interface ProjectRollupFigures {
  budget_amount: number | null;
  committed_total: number;
  paid_total: number;
  estimated_total: number;
  quoted_production: number;
}

export type ProjectHealth = "no-budget" | "on-track" | "watch" | "at-risk" | "over";

export interface ProjectOutlook {
  /** Committed spend, with the estimated portion calibrated by history. */
  predictedFinal: number;
  /** Predicted final as a share of the budget. Null when uncapped. */
  budgetUsed: number | null;
  remaining: number | null;
  health: ProjectHealth;
  /** Positive means predicted to land above what was quoted. */
  varianceVsQuote: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Sum rate card lines into a single low/high range, honouring quantity. */
export function rollUpRange(lines: RateCardLine[]): CostRange {
  return lines.reduce<CostRange>(
    (acc, line) => {
      const qty = line.quantity ?? 1;
      return {
        low: acc.low + line.cost_low * qty,
        high: acc.high + line.cost_high * qty,
      };
    },
    { low: 0, high: 0 }
  );
}

/**
 * How much weight to give the calibration factor.
 *
 * Below three closed jobs the database returns 1.0 and there is nothing
 * to report. Beyond that, more history means a more trustworthy factor.
 * The bands are deliberately coarse: this is a signal about whether to
 * trust the number, not a precision instrument.
 */
export function confidenceFromSamples(closedJobs: number): Confidence {
  if (closedJobs < 3) return "none";
  if (closedJobs < 6) return "low";
  if (closedJobs < 12) return "medium";
  return "high";
}

/**
 * Apply the historical calibration factor to a raw rate card range.
 *
 * A factor is ignored unless it is finite and positive, so a null from
 * the database or a divide-by-zero upstream degrades to "no correction"
 * rather than to a zero-cost quote.
 */
export function calibrate(range: CostRange, factor: number): CostRange {
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return {
    low: round2(range.low * safe),
    high: round2(range.high * safe),
  };
}

export function predictProductionCost(
  lines: RateCardLine[],
  factor = 1,
  closedJobs = 0
): CostPrediction {
  const raw = rollUpRange(lines);
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const calibrated = calibrate(raw, safeFactor);
  return {
    raw: { low: round2(raw.low), high: round2(raw.high) },
    calibrated,
    point: round2((calibrated.low + calibrated.high) / 2),
    factor: safeFactor,
    confidence: confidenceFromSamples(closedJobs),
  };
}

/**
 * Turn a production cost into a retail price.
 *
 * The warnings matter more than the arithmetic. Underpricing in this
 * practice happens through small compulsory costs going unrecorded, so
 * the function flags the shapes that usually mean something is missing.
 */
export function suggestRetail(
  productionCost: number,
  marginMultiplier: number,
  opts: { rangeWidth?: number; lineCount?: number } = {}
): RetailSuggestion {
  const warnings: string[] = [];
  const multiplier =
    Number.isFinite(marginMultiplier) && marginMultiplier > 0 ? marginMultiplier : 1;

  if (multiplier < 2) {
    warnings.push(
      "Margin below 2x leaves nothing for studio overheads, packaging or unsold stock."
    );
  }
  if (productionCost <= 0) {
    warnings.push("Production cost is zero. Nothing has been costed yet.");
  }
  if (opts.lineCount !== undefined && opts.lineCount > 0 && opts.lineCount < 3) {
    warnings.push(
      "Fewer than three cost lines. Hallmarking, chain and packaging are the ones usually forgotten."
    );
  }
  if (
    opts.rangeWidth !== undefined &&
    productionCost > 0 &&
    opts.rangeWidth / productionCost > 0.5
  ) {
    warnings.push(
      "The cost range spans more than half the estimate. Quote the high end or narrow the range first."
    );
  }

  const suggestedRetail = round2(productionCost * multiplier);
  return {
    productionCost: round2(productionCost),
    marginMultiplier: multiplier,
    suggestedRetail,
    grossMargin: round2(suggestedRetail - productionCost),
    warnings,
  };
}

/**
 * Where a project is predicted to land.
 *
 * Only the estimated portion of committed spend gets calibrated. Amounts
 * already paid are facts and are never adjusted, which keeps the
 * prediction from drifting on projects that are nearly closed.
 */
export function projectOutlook(
  figures: ProjectRollupFigures,
  factor = 1
): ProjectOutlook {
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const known = figures.committed_total - figures.estimated_total;
  const predictedFinal = round2(known + figures.estimated_total * safeFactor);

  const budget = figures.budget_amount;
  const budgetUsed =
    budget !== null && budget > 0 ? round2(predictedFinal / budget) : null;
  const remaining = budget !== null ? round2(budget - predictedFinal) : null;

  let health: ProjectHealth;
  if (budgetUsed === null) health = "no-budget";
  else if (budgetUsed > 1) health = "over";
  else if (budgetUsed >= 0.9) health = "at-risk";
  else if (budgetUsed >= 0.75) health = "watch";
  else health = "on-track";

  return {
    predictedFinal,
    budgetUsed,
    remaining,
    health,
    varianceVsQuote: round2(predictedFinal - figures.quoted_production),
  };
}

export const HEALTH_LABELS: Record<ProjectHealth, string> = {
  "no-budget": "No budget set",
  "on-track": "On track",
  watch: "Watch",
  "at-risk": "At risk",
  over: "Over budget",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  none: "No history yet, quoting uncalibrated",
  low: "Calibrated on a handful of jobs",
  medium: "Calibrated on a reasonable history",
  high: "Well calibrated",
};
