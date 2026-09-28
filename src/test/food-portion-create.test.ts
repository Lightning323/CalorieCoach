import assert from "node:assert/strict";
import test from "node:test";
import { FoodPortion } from "../utils/food-database";
import { selectResolvedPortion } from "../coach-ai/usda-food-resolver";

function hundredGramPortion(rank = 1): FoodPortion {
  return { amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank };
}

test("creates a user-based portion with the LLM-estimated gram weight", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = await selectResolvedPortion(portions, { unit: "slice", gramWeight: 120 }, "slices");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "slice" }, gramWeight: 120, rank: 2 });
  assert.equal(portions.length, 2);
});

test("singularizes a plural user unit when inventing a portion", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = await selectResolvedPortion(portions, { unit: "slices", gramWeight: 120 }, "slices");

  assert.equal(portion?.measureUnit?.name, "slice");
  assert.equal(portion?.gramWeight, 120);
});

test("reuses an existing related portion over inventing a new one", async () => {
  const portions: FoodPortion[] = [
    { amount: 1, gramWeight: 150, measureUnit: { name: "slice" }, rank: 1 },
    hundredGramPortion(2),
  ];
  const before = portions.length;

  const portion = await selectResolvedPortion(portions, { unit: "slice", gramWeight: 121 }, "slices");

  assert.equal(portions.length, before);
  assert.equal(portion?.gramWeight, 150);
  assert.equal(portion?.measureUnit?.name, "slice");
});

test("records an exact mass portion when the user logged by mass", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = await selectResolvedPortion(portions, { unit: "g", gramWeight: 150 }, "g");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "g" }, gramWeight: 1, rank: 2 });
});

test("prefers an existing portion in the user's unit when the LLM has no portion", async () => {
  const portions: FoodPortion[] = [
    { amount: 1, gramWeight: 150, measureUnit: { name: "slice" }, rank: 1 },
    hundredGramPortion(2),
  ];

  const portion = await selectResolvedPortion(portions, null, "slices");

  assert.equal(portion?.measureUnit?.name, "slice");

  const noUnitMatch = await selectResolvedPortion(portions, null, "cups");
  assert.equal(noUnitMatch, portions[0]);
});

test("creates a measure the parser could not weigh from an estimate", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  // "3 cups of spaghetti" on a food stored only as 100 g: the parser offered no
  // cup weight, so the food's own record weighs one cup instead.
  const portion = await selectResolvedPortion(portions, { unit: "g", gramWeight: 100 }, "cups", () => 200);

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "cup" }, gramWeight: 200, rank: 2 });
  assert.equal(portions.length, 2);
});

test("awaits an estimate that reads a food's USDA record", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = await selectResolvedPortion(portions, null, "cups", async () => 240);

  assert.equal(portion?.measureUnit?.name, "cup");
  assert.equal(portion?.gramWeight, 240);
});

test("prefers the parser's own weight for a measure over an estimate", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];
  let asked = 0;

  const portion = await selectResolvedPortion(portions, { unit: "cup", gramWeight: 195 }, "cups", () => {
    asked++;
    return 240;
  });

  assert.equal(portion?.gramWeight, 195);
  assert.equal(asked, 0, "an existing estimate makes the extra lookup unnecessary");
});

test("falls back to the food's own measure when the estimate says nothing", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];

  const portion = await selectResolvedPortion(portions, { unit: "g", gramWeight: 100 }, "cups", () => undefined);

  assert.equal(portion?.measureUnit?.name, "gram");
  assert.equal(portions.length, 1, "no measure is invented without a weight");
});

test("never estimates a measure for a generic or mass logged unit", async () => {
  const portions: FoodPortion[] = [hundredGramPortion()];
  const asked: string[] = [];

  await selectResolvedPortion(portions, null, "serving", unit => {
    asked.push(unit);
    return 100;
  });
  await selectResolvedPortion(portions, null, "g", unit => {
    asked.push(unit);
    return 1;
  });

  assert.deepEqual(asked, []);
  assert.equal(portions.length, 1);
});
