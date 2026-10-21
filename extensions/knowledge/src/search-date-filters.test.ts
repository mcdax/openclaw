import { expect, it } from "vitest";
import { temporalSelectionError, temporalQuery } from "./search-date-filters.js";
const selection = (changes = {}) => ({
  since: "",
  until: "",
  timeField: "occurred_at",
  ...changes,
});

it("temporal UI accepts only real explicit calendar dates or timezone-bearing timestamps", () => {
  for (const since of ["2026-10-04", "2024-02-29", "2026-10-04T12:30:00-07:00"]) {
    expect(temporalSelectionError(selection({ since }) as any)).toBe("");
  }
  for (const since of ["yesterday", "2026-02-29", "2026-10-04T12:30:00", "2026-10-04T24:30:00Z"]) {
    expect(temporalSelectionError(selection({ since }) as any)).toMatch(/Since must/);
  }
  expect(
    temporalSelectionError(selection({ since: "2026-10-05", until: "2026-10-04" }) as any),
  ).toMatch(/Since must not be after Until/);
  expect(
    temporalSelectionError(
      selection({ since: "2026-10-04T23:59:59Z", until: "2026-10-04" }) as any,
    ),
  ).toBe("");
});

it("text search date predicates omit blanks", () => {
  expect(temporalQuery(selection() as any)).toStrictEqual({ timeField: "occurred_at" });
  expect(
    temporalQuery(selection({ timeField: "due_at", since: "2026-10-04" }) as any),
  ).toStrictEqual({
    timeField: "due_at",
    since: "2026-10-04",
  });
});
