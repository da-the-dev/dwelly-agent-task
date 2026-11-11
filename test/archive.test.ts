// The archive is the answer key. This test pins the facts the evals will build on,
// so a re-fetched archive that changes them fails loudly instead of silently.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HistoryCasesResponse } from "../src/api/types.js";

const archive = JSON.parse(
  readFileSync(new URL("../data/history.json", import.meta.url), "utf8"),
) as HistoryCasesResponse;
const byId = new Map(archive.cases.map((c) => [c.id, c]));

describe("archive snapshot", () => {
  it("has 15 cases", () => {
    expect(archive.cases).toHaveLength(15);
  });

  it.each(["case-03", "case-05", "case-11", "case-14"])(
    "%s was handled without a contractor and cost nothing",
    (id) => {
      const c = byId.get(id);
      expect(c?.contractor?.id ?? null).toBeNull();
      expect(c?.cost_gbp).toBe(0);
    },
  );

  it("case-04: 'no rush' in the title, but classified high", () => {
    expect(byId.get("case-04")?.classification.urgency).toBe("high");
  });
});
