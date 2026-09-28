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

/** A food stored with USDA's 100 g basis only, as the request describes. */
function hundredGramFood(): FoodItem {
  return {
    names: ["spaghetti"],
    foodNutrients: { calories: 158, carbs: 30.9 },
    foodPortions: [{ amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 1 }],
  };
}

test("logs a counted new food as the count that was asked for, not as servings", async () => {
  const portions = mandsPortions();

  const portion = await selectResolvedPortion(portions, { unit: "candy", gramWeight: 0.9 }, "candies");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "candy" }, gramWeight: 0.9, rank: 3 });
  assert.equal(getFoodPortionName(portion!), "1 candy");
});

test("singularizes a plural logged unit on a new food", async () => {
  const portions = mandsPortions();

  const portion = await selectResolvedPortion(portions, { unit: "candies", gramWeight: 0.9 }, "candies");

  assert.equal(portion?.measureUnit?.name, "candy");
  assert.equal(portion?.gramWeight, 0.9);
});

test("reuses a new food's existing measure in the logged unit", async () => {
  const portions: FoodPortion[] = [
    { amount: 1, gramWeight: 0.9, measureUnit: { name: "candy" }, rank: 1 },
    ...mandsPortions().map((portion, index) => ({ ...portion, rank: index + 2 })),
  ];

  const portion = await selectResolvedPortion(portions, { unit: "candy", gramWeight: 0.88 }, "candies");

  assert.equal(portion?.measureUnit?.name, "candy");
  assert.equal(portion?.gramWeight, 0.9);
  assert.equal(portions.length, 3);
});

test("does not record a whole serving's weight as the weight of one candy", async () => {
  const portions = mandsPortions();

  // The AI fell back to the food's generic serving even though the person
  // counted candies, so its weight says nothing about a single candy.
  const portion = await selectResolvedPortion(portions, { unit: "serving", gramWeight: 1.69 }, "candies");

  assert.equal(portion?.measureUnit?.name, "serving");
  assert.equal(portions.length, 2);
});

test("never treats a generic logged unit as a measure to create", async () => {
  assert.equal(isGenericMeasureUnit("serving"), true);
  assert.equal(isGenericMeasureUnit("servings"), true);
  assert.equal(isGenericMeasureUnit("candies"), false);

  const portions = mandsPortions();
  const portion = await selectResolvedPortion(portions, { unit: "serving", gramWeight: 1.69 }, "serving");

  assert.equal(portion?.measureUnit?.name, "serving");
  assert.equal(portions.length, 2);
});

test("logs a mass-based new food without creating a countable measure", async () => {
  const portions: FoodPortion[] = [{ amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 1 }];

  const portion = await selectResolvedPortion(portions, { unit: "g", gramWeight: 150 }, "g");

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "g" }, gramWeight: 1, rank: 2 });
});

test("adds the logged measure to an existing database food", async () => {
  const food = mandsFood();

  const portion = await resolveDatabaseMatchPortion(food, { unit: "candy", gramWeight: 0.9 }, "candies");

  assert.equal(portion?.measureUnit?.name, "candy");
  assert.equal(portion?.gramWeight, 0.9);
  assert.equal(food.foodPortions.length, 3, "the new measure stays on the food so it can be saved");
  assert.equal(getFoodPortionName(food.foodPortions[2]), "1 candy");
});

test("reuses an existing database food's measure instead of adding a duplicate", async () => {
  const food = mandsFood([
    { amount: 1, gramWeight: 0.9, measureUnit: { name: "candy" }, rank: 1 },
    ...mandsPortions().map((portion, index) => ({ ...portion, rank: index + 2 })),
  ]);

  const portion = await resolveDatabaseMatchPortion(food, { unit: "candy", gramWeight: 0.95 }, "candies");

  assert.equal(portion?.gramWeight, 0.9);
  assert.equal(food.foodPortions.length, 3);
});

test("adds the logged measure to an existing food the parser could not weigh", async () => {
  const food = mandsFood();

  // The parser named the measure but returned no weight, so nothing trustworthy
  // describes a single candy and the food's own serving is kept.
  const portion = await resolveDatabaseMatchPortion(food, { unit: "candies" }, "candies");

  assert.equal(portion?.measureUnit?.name, "serving");
  assert.equal(food.foodPortions.length, 2);
});

test("leaves a database food with no measures for the caller's fallback", async () => {
  const food = mandsFood([]);

  const portion = await resolveDatabaseMatchPortion(food, { unit: "candy", gramWeight: 0.9 }, "candies");

  assert.equal(portion, undefined);
  assert.deepEqual(food.foodPortions, []);
});

test("adds a cup measure to a food stored only as 100 g", async () => {
  const food = hundredGramFood();

  // "3 cups of spaghetti": the parser copied the food's 100 g basis, which says
  // nothing about a cup, so one cup is weighed from the food's USDA record.
  const portion = await resolveDatabaseMatchPortion(
    food,
    { unit: "g", gramWeight: 100 },
    "cups",
    () => 200,
  );

  assert.deepEqual(portion, { amount: 1, measureUnit: { name: "cup" }, gramWeight: 200, rank: 2 });
  assert.equal(food.foodPortions.length, 2, "the cup measure stays on the food so it can be saved");
  assert.equal(getFoodPortionName(food.foodPortions[1]), "1 cup");
});

test("adds the logged measure when the parser returned no portion at all", async () => {
  const food = hundredGramFood();

  const portion = await resolveDatabaseMatchPortion(food, undefined, "cups", () => 200);

  assert.equal(portion?.measureUnit?.name, "cup");
  assert.equal(food.foodPortions.length, 2);
});

test("does not add a second measure for a food that already has the unit", async () => {
  const food = hundredGramFood();
  food.foodPortions.push({ amount: 1, gramWeight: 200, measureUnit: { name: "cup" }, rank: 2 });

  const portion = await resolveDatabaseMatchPortion(food, { unit: "g", gramWeight: 100 }, "cups", () => 240);

  assert.equal(portion?.gramWeight, 200, "the stored measure wins over a fresh estimate");
  assert.equal(food.foodPortions.length, 2);
});

test("keeps the food's own measure when the unit cannot be weighed", async () => {
  const food = hundredGramFood();

  const portion = await resolveDatabaseMatchPortion(food, { unit: "g", gramWeight: 100 }, "cups", () => undefined);

  assert.equal(portion?.measureUnit?.name, "gram");
  assert.equal(food.foodPortions.length, 1, "no measure is invented without a weight");
});
