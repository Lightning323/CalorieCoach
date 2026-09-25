import assert from "node:assert/strict";
import test from "node:test";
import { FoodPortion } from "../utils/food-database";
import { selectResolvedPortion } from "../coach-ai/usda-food-resolver";

function hundredGramPortion(rank = 1): FoodPortion {
  return { amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank };
}

test("creates a user-based portion with the LLM-estimated gram weight", () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = selectResolvedPortion(portions, { unit: "slice", gramWeight: 120 }, "slices");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "slice" }, gramWeight: 120, rank: 2 });
  assert.equal(portions.length, 2);
});

test("singularizes a plural user unit when inventing a portion", () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = selectResolvedPortion(portions, { unit: "slices", gramWeight: 120 }, "slices");

  assert.equal(portion?.measureUnit?.name, "slice");
  assert.equal(portion?.gramWeight, 120);
});

test("reuses an existing related portion over inventing a new one", () => {
  const portions: FoodPortion[] = [
    { amount: 1, gramWeight: 150, measureUnit: { name: "slice" }, rank: 1 },
    hundredGramPortion(2),
  ];
  const before = portions.length;

  const portion = selectResolvedPortion(portions, { unit: "slice", gramWeight: 121 }, "slices");

  assert.equal(portions.length, before);
  assert.equal(portion?.gramWeight, 150);
  assert.equal(portion?.measureUnit?.name, "slice");
});

test("records an exact mass portion when the user logged by mass", () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = selectResolvedPortion(portions, { unit: "g", gramWeight: 150 }, "g");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "g" }, gramWeight: 1, rank: 2 });
});

test("prefers an existing portion in the user's unit when the LLM has no portion", () => {
  const portions: FoodPortion[] = [
    { amount: 1, gramWeight: 150, measureUnit: { name: "slice" }, rank: 1 },
    hundredGramPortion(2),
  ];

  const portion = selectResolvedPortion(portions, null, "slices");

  assert.equal(portion?.measureUnit?.name, "slice");

  const noUnitMatch = selectResolvedPortion(portions, null, "cups");
  assert.equal(noUnitMatch, portions[0]);
});