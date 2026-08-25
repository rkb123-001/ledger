import { describe, it, expect } from "vitest";
import {
  rollUpRange,
  allocateFromRate,
  calibrate,
  confidenceFromSamples,
  predictProductionCost,
  suggestRetail,
  projectOutlook,
} from "./predict";

describe("rollUpRange", () => {
  it("sums low and high separately", () => {
    expect(
      rollUpRange([
        { cost_low: 35, cost_high: 40 },
        { cost_low: 10, cost_high: 10 },
      ])
    ).toEqual({ low: 45, high: 50 });
  });

  it("honours quantity", () => {
    expect(rollUpRange([{ cost_low: 30, cost_high: 40, quantity: 3 }])).toEqual({
      low: 90,
      high: 120,
    });
  });

  it("returns a zero range for no lines", () => {
    expect(rollUpRange([])).toEqual({ low: 0, high: 0 });
  });
});

describe("allocateFromRate", () => {
  it("commits the midpoint by default", () => {
    const a = allocateFromRate({ cost_low: 30, cost_high: 40 });
    expect(a.point).toBe("mid");
    expect(a.unit).toBe(35);
    expect(a.amount).toBe(35);
    expect(a.quantity).toBe(1);
  });

  it("commits either end when asked", () => {
    const line = { cost_low: 30, cost_high: 40 };
    expect(allocateFromRate(line, { point: "low" }).amount).toBe(30);
    expect(allocateFromRate(line, { point: "high" }).amount).toBe(40);
  });

  it("multiplies by quantity", () => {
    expect(allocateFromRate({ cost_low: 12.5, cost_high: 12.5 }, { quantity: 4 }).amount).toBe(50);
  });

  it("flags anything drawn from a spread as an estimate", () => {
    expect(allocateFromRate({ cost_low: 30, cost_high: 40 }).isEstimate).toBe(true);
    // Even at the ends: the range is what makes it a guess, not the pick.
    expect(allocateFromRate({ cost_low: 30, cost_high: 40 }, { point: "high" }).isEstimate).toBe(true);
  });

  it("treats a settled price as a fact rather than an estimate", () => {
    expect(allocateFromRate({ cost_low: 12, cost_high: 12 }).isEstimate).toBe(false);
    // A zero is an unfilled cell, not a free input.
    expect(allocateFromRate({ cost_low: 0, cost_high: 0 }).isEstimate).toBe(true);
  });

  it("survives a rate card row entered the wrong way round", () => {
    const a = allocateFromRate({ cost_low: 90, cost_high: 10 }, { point: "low" });
    expect(a.amount).toBe(10);
    expect(allocateFromRate({ cost_low: 90, cost_high: 10 }, { point: "high" }).amount).toBe(90);
  });

  it("never puts a NaN or a fractional count into a budget", () => {
    expect(allocateFromRate({ cost_low: NaN, cost_high: 40 }).amount).toBe(20);
    expect(allocateFromRate({ cost_low: 30, cost_high: 40 }, { quantity: 2.7 }).quantity).toBe(2);
    expect(allocateFromRate({ cost_low: 30, cost_high: 40 }, { quantity: 0 }).quantity).toBe(1);
    expect(allocateFromRate({ cost_low: 30, cost_high: 40 }, { quantity: NaN }).quantity).toBe(1);
  });

  it("warns rather than silently committing an uncosted rate", () => {
    expect(allocateFromRate({ cost_low: 0, cost_high: 0 }).warnings).toHaveLength(1);
  });

  it("warns when the midpoint is being taken from a very wide range", () => {
    expect(allocateFromRate({ cost_low: 10, cost_high: 90 }).warnings).toHaveLength(1);
    expect(allocateFromRate({ cost_low: 30, cost_high: 40 }).warnings).toHaveLength(0);
    // Picking an end is a deliberate choice, so it is not second-guessed.
    expect(allocateFromRate({ cost_low: 10, cost_high: 90 }, { point: "high" }).warnings).toHaveLength(0);
  });
});

describe("calibrate", () => {
  it("scales both ends of the range", () => {
    expect(calibrate({ low: 100, high: 200 }, 1.2)).toEqual({ low: 120, high: 240 });
  });

  it("ignores a zero, negative or non-finite factor rather than zeroing the quote", () => {
    const range = { low: 100, high: 200 };
    expect(calibrate(range, 0)).toEqual(range);
    expect(calibrate(range, -1)).toEqual(range);
    expect(calibrate(range, NaN)).toEqual(range);
    expect(calibrate(range, Infinity)).toEqual(range);
  });
});

describe("confidenceFromSamples", () => {
  it("reports no confidence below the database's own three-job threshold", () => {
    expect(confidenceFromSamples(0)).toBe("none");
    expect(confidenceFromSamples(2)).toBe("none");
  });

  it("bands upward with history", () => {
    expect(confidenceFromSamples(3)).toBe("low");
    expect(confidenceFromSamples(6)).toBe("medium");
    expect(confidenceFromSamples(12)).toBe("high");
  });
});

describe("predictProductionCost", () => {
  it("quotes the midpoint of the calibrated range", () => {
    const p = predictProductionCost(
      [
        { cost_low: 35, cost_high: 40 }, // fabrication, quoted as a range
        { cost_low: 10, cost_high: 10 }, // an outside service at a fixed price
        { cost_low: 8, cost_high: 12 },  // materials
      ],
      1.2,
      6
    );
    expect(p.raw).toEqual({ low: 53, high: 62 });
    expect(p.calibrated).toEqual({ low: 63.6, high: 74.4 });
    expect(p.point).toBe(69);
    expect(p.confidence).toBe("medium");
  });

  it("defaults to an uncalibrated quote with no history", () => {
    const p = predictProductionCost([{ cost_low: 50, cost_high: 50 }]);
    expect(p.factor).toBe(1);
    expect(p.point).toBe(50);
    expect(p.confidence).toBe("none");
  });
});

describe("suggestRetail", () => {
  it("applies the multiplier and reports cash margin", () => {
    const r = suggestRetail(69, 4);
    expect(r.suggestedRetail).toBe(276);
    expect(r.grossMargin).toBe(207);
    expect(r.warnings).toHaveLength(0);
  });

  it("warns when the margin will not cover overheads", () => {
    expect(suggestRetail(100, 1.5).warnings.join(" ")).toMatch(/overheads/i);
  });

  it("warns when too few cost lines suggest something was forgotten", () => {
    expect(suggestRetail(40, 4, { lineCount: 2 }).warnings.join(" ")).toMatch(
      /Outside services, consumables and packaging/
    );
  });

  it("warns when the range is too wide to quote from", () => {
    expect(
      suggestRetail(100, 4, { rangeWidth: 80 }).warnings.join(" ")
    ).toMatch(/narrow the range/i);
  });

  it("never divides by a zero or negative multiplier", () => {
    expect(suggestRetail(100, 0).suggestedRetail).toBe(100);
    expect(suggestRetail(100, -3).suggestedRetail).toBe(100);
  });
});

describe("projectOutlook", () => {
  const base = {
    budget_amount: 250,
    committed_total: 68,
    paid_total: 38,
    estimated_total: 30,
    quoted_production: 60,
  };

  it("calibrates only the estimated portion, never what is already paid", () => {
    const o = projectOutlook(base, 1.2);
    // 38 paid stays fixed, 30 estimated becomes 36
    expect(o.predictedFinal).toBe(74);
    expect(o.varianceVsQuote).toBe(14);
  });

  it("leaves a fully paid project untouched by the factor", () => {
    const o = projectOutlook(
      { ...base, committed_total: 68, estimated_total: 0 },
      2
    );
    expect(o.predictedFinal).toBe(68);
  });

  it("bands health against the budget", () => {
    expect(projectOutlook({ ...base, committed_total: 100, estimated_total: 0 }).health)
      .toBe("on-track");
    expect(projectOutlook({ ...base, committed_total: 200, estimated_total: 0 }).health)
      .toBe("watch");
    expect(projectOutlook({ ...base, committed_total: 240, estimated_total: 0 }).health)
      .toBe("at-risk");
    expect(projectOutlook({ ...base, committed_total: 300, estimated_total: 0 }).health)
      .toBe("over");
  });

  it("reports no-budget rather than guessing when the project is uncapped", () => {
    const o = projectOutlook({ ...base, budget_amount: null });
    expect(o.health).toBe("no-budget");
    expect(o.budgetUsed).toBeNull();
    expect(o.remaining).toBeNull();
  });
});
