import assert from "node:assert/strict";
import test from "node:test";
import {
  isGenericMeasureUnit,
  resolveDatabaseMatchPortion,
  selectResolvedPortion,
} from "../coach-ai/usda-food-resolver";
import { FoodItem, FoodPortion, getFoodPortionName } from "../utils/food-database";

/** M&M's, as USDA records it: a generic serving plus the 100 g nutrient basis. */
function mandsPortions(): FoodPortion[] {
  return [
    { amount: 1, gramWeight: 1.69, measureUnit: { name: "serving" }, rank: 1 },
    { amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 2 },
  ];
}

function mandsFood(portions: FoodPortion[] = mandsPortions()): FoodItem {
  return { names: ["m&m's"], foodNutrients: { calories: 500 }, foodPortions: portions };
}

test("logs a counted new food as the count that was asked for, not as servings", () => {
  const portions = mandsPortions();

  const portion = selectResolvedPortion(portions, { unit: "candy", gramWeight: 0.9 }, "candies");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "candy" }, gramWeight: 0.9, rank: 3 });
  assert.equal(getFoodPortionName(portion!), "1 candy");
});

test("singularizes a plural logged unit on a new food", () => {
  const portions = mandsPortions();

  const portion = selectResolvedPortion(portions, { unit: "candies", gramWeight: 0.9 }, "candies");

  assert.equal(portion?.measureUnit?.name, "candy");
  assert.equal(portion?.gramWeight, 0.9);
});

test("reuses a new food's existing measure in the logged unit", () => {
  const portions: FoodPortion[] = [
    { amount: 1, gramWeight: 0.9, measureUnit: { name: "candy" }, rank: 1 },
    ...mandsPortions().map((portion, index) => ({ ...portion, rank: index + 2 })),
  ];

  const portion = selectResolvedPortion(portions, { unit: "candy", gramWeight: 0.88 }, "candies");

  assert.equal(portion?.measureUnit?.name, "candy");
  assert.equal(portion?.gramWeight, 0.9);
  assert.equal(portions.length, 3);
});

test("does not record a whole serving's weight as the weight of one candy", () => {
  const portions = mandsPortions();

  // The AI fell back to the food's generic serving even though the person
  // counted candies, so its weight says nothing about a single candy.
  const portion = selectResolvedPortion(portions, { unit: "serving", gramWeight: 1.69 }, "candies");

  assert.equal(portion?.measureUnit?.name, "serving");
  assert.equal(portions.length, 2);
});

test("never treats a generic logged unit as a measure to create", () => {
  assert.equal(isGenericMeasureUnit("serving"), true);
  assert.equal(isGenericMeasureUnit("servings"), true);
  assert.equal(isGenericMeasureUnit("candies"), false);

  const portions = mandsPortions();
  const portion = selectResolvedPortion(portions, { unit: "serving", gramWeight: 1.69 }, "serving");

  assert.equal(portion?.measureUnit?.name, "serving");
  assert.equal(portions.length, 2);
});

test("logs a mass-based new food without creating a countable measure", () => {
  const portions: FoodPortion[] = [{ amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 1 }];

  const portion = selectResolvedPortion(portions, { unit: "g", gramWeight: 150 }, "g");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "g" }, gramWeight: 1, rank: 2 });
});

test("adds the logged measure to an existing database food", () => {
  const food = mandsFood();

  const portion = resolveDatabaseMatchPortion(food, { unit: "candy", gramWeight: 0.9 }, "candies");

  assert.equal(portion?.measureUnit?.name, "candy");
  assert.equal(portion?.gramWeight, 0.9);
  assert.equal(food.foodPortions.length, 3, "the new measure stays on the food so it can be saved");
  assert.equal(getFoodPortionName(food.foodPortions[2]), "1 candy");
});

test("reuses an existing database food's measure instead of adding a duplicate", () => {
  const food = mandsFood([
    { amount: 1, gramWeight: 0.9, measureUnit: { name: "candy" }, rank: 1 },
    ...mandsPortions().map((portion, index) => ({ ...portion, rank: index + 2 })),
  ]);

  const portion = resolveDatabaseMatchPortion(food, { unit: "candy", gramWeight: 0.95 }, "candies");

  assert.equal(portion?.gramWeight, 0.9);
  assert.equal(food.foodPortions.length, 3);
});

test("adds the logged measure to an existing food the parser could not weigh", () => {
  const food = mandsFood();

  // The parser named the measure but returned no weight, so nothing trustworthy
  // describes a single candy and the food's own serving is kept.
  const portion = resolveDatabaseMatchPortion(food, { unit: "candies" }, "candies");

  assert.equal(portion?.measureUnit?.name, "serving");
  assert.equal(food.foodPortions.length, 2);
});

test("leaves a database food with no measures for the caller's fallback", () => {
  const food = mandsFood([]);

  const portion = resolveDatabaseMatchPortion(food, { unit: "candy", gramWeight: 0.9 }, "candies");

  assert.equal(portion, undefined);
  assert.deepEqual(food.foodPortions, []);
});
