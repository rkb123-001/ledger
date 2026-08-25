import { describe, it, expect } from "vitest";
import { toBlockLines, summariseBlock, linesToInsert } from "./rateblocks";

const ROWS = [
  {
    id: "a",
    user_id: "u",
    category: "Fabrication",
    description: "Outsourced fabrication",
    cost_low: 35,
    cost_high: 40,
    pot_name: "Makers",
    notes: null,
    sort_order: 1,
  },
  {
    id: "b",
    user_id: "u",
    category: "Fabrication",
    description: "Finishing",
    cost_low: 10,
    cost_high: 10,
    pot_name: null,
    notes: "per piece",
    sort_order: 2,
  },
];

describe("toBlockLines", () => {
  it("keeps the costing content and drops the row identity", () => {
    const lines = toBlockLines(ROWS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      description: "Outsourced fabrication",
      cost_low: 35,
      cost_high: 40,
      pot_name: "Makers",
      notes: null,
      category: "Fabrication",
    });
    // A block is a recipe, not a copy of rows.
    expect(lines[0]).not.toHaveProperty("id");
    expect(lines[0]).not.toHaveProperty("user_id");
    expect(lines[0]).not.toHaveProperty("sort_order");
  });

  it("drops nameless rows rather than saving them as blanks", () => {
    const lines = toBlockLines([
      ...ROWS,
      { category: "Fabrication", description: "   ", cost_low: 5, cost_high: 9 },
    ]);
    expect(lines).toHaveLength(2);
  });

  it("normalises a range that was entered the wrong way round", () => {
    const [line] = toBlockLines([{ description: "Casting", cost_low: 90, cost_high: 10 }]);
    expect(line.cost_low).toBe(10);
    expect(line.cost_high).toBe(90);
  });

  it("turns blank text into null and junk numbers into zero", () => {
    const [line] = toBlockLines([
      { description: "Sundries", cost_low: "", cost_high: null, pot_name: "  ", notes: "", category: "" },
    ]);
    expect(line).toEqual({
      description: "Sundries",
      cost_low: 0,
      cost_high: 0,
      pot_name: null,
      notes: null,
      category: null,
    });
  });

  it("returns an empty block for no rows at all", () => {
    expect(toBlockLines([])).toEqual([]);
    expect(toBlockLines(null)).toEqual([]);
    expect(toBlockLines(undefined)).toEqual([]);
  });
});

describe("summariseBlock", () => {
  it("counts lines and sums both ends of the range", () => {
    const s = summariseBlock({ name: "Making", lines: toBlockLines(ROWS) });
    expect(s.lineCount).toBe(2);
    expect(s.low).toBe(45);
    expect(s.high).toBe(50);
  });

  it("lists the categories the block will create, in first-seen order", () => {
    const s = summariseBlock({
      name: "Starter",
      lines: [
        { description: "a", cost_low: 1, cost_high: 1, pot_name: null, notes: null, category: "Labour" },
        { description: "b", cost_low: 1, cost_high: 1, pot_name: null, notes: null, category: "Materials" },
        { description: "c", cost_low: 1, cost_high: 1, pot_name: null, notes: null, category: "Labour" },
      ],
    });
    expect(s.categories).toEqual(["Labour", "Materials"]);
  });

  it("shows the block name for lines that carry no category of their own", () => {
    const s = summariseBlock({
      name: "Research costs",
      lines: [
        { description: "Transcription", cost_low: 20, cost_high: 30, pot_name: null, notes: null, category: null },
      ],
    });
    // What is previewed has to be what lands.
    expect(s.categories).toEqual(["Research costs"]);
  });

  it("reports an empty block as empty rather than throwing", () => {
    expect(summariseBlock({ name: "Empty", lines: [] })).toEqual({
      lineCount: 0,
      categories: [],
      low: 0,
      high: 0,
    });
  });
});

describe("linesToInsert", () => {
  const block = { name: "Making", lines: toBlockLines(ROWS) };

  it("produces rate card rows that append rather than collide", () => {
    const rows = linesToInsert(block, { startSortOrder: 12 });
    expect(rows.map((r) => r.sort_order)).toEqual([13, 14]);
  });

  it("starts from the top of an empty card", () => {
    expect(linesToInsert(block).map((r) => r.sort_order)).toEqual([1, 2]);
  });

  it("keeps each line's own category by default", () => {
    expect(linesToInsert(block).every((r) => r.category === "Fabrication")).toBe(true);
  });

  it("collapses everything into one category when told to", () => {
    const rows = linesToInsert(block, { category: "  Production  " });
    expect(rows.every((r) => r.category === "Production")).toBe(true);
  });

  it("falls back to the block name, never to a blank category", () => {
    const rows = linesToInsert({
      name: "Research costs",
      lines: [
        { description: "Transcription", cost_low: 20, cost_high: 30, pot_name: null, notes: null, category: null },
      ],
    });
    expect(rows[0].category).toBe("Research costs");
  });

  it("never emits a blank category even for an unnamed block", () => {
    const rows = linesToInsert({
      name: "   ",
      lines: [
        { description: "Something", cost_low: 1, cost_high: 2, pot_name: null, notes: null, category: null },
      ],
    });
    expect(rows[0].category).toBe("Uncategorised");
  });

  it("names a line that lost its description rather than inserting a blank", () => {
    const rows = linesToInsert({
      name: "Making",
      lines: [{ description: "", cost_low: 1, cost_high: 2, pot_name: null, notes: null, category: null }],
    });
    expect(rows[0].description).toBe("Untitled rate");
  });

  it("repairs a reversed or non-finite range on the way back out", () => {
    const rows = linesToInsert({
      name: "Making",
      lines: [
        { description: "Reversed", cost_low: 80, cost_high: 20, pot_name: null, notes: null, category: null },
        { description: "Junk", cost_low: NaN, cost_high: 40, pot_name: null, notes: null, category: null },
      ],
    });
    expect(rows[0]).toMatchObject({ cost_low: 20, cost_high: 80 });
    expect(rows[1]).toMatchObject({ cost_low: 0, cost_high: 40 });
  });

  it("is a no-op for an empty block", () => {
    expect(linesToInsert({ name: "Empty", lines: [] })).toEqual([]);
  });

  it("round-trips a card through save and apply without drift", () => {
    const saved = toBlockLines(ROWS);
    const applied = linesToInsert({ name: "Making", lines: saved }, { startSortOrder: 0 });
    expect(applied.map(({ sort_order, ...rest }) => rest)).toEqual(
      ROWS.map((r) => ({
        category: r.category,
        description: r.description,
        cost_low: r.cost_low,
        cost_high: r.cost_high,
        pot_name: r.pot_name,
        notes: r.notes,
      }))
    );
  });
});
