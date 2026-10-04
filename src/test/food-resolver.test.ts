import assert from "node:assert/strict";
import test from "node:test";
import { UsdaFood } from "../api/usdaFoodDataApi";
import { FoodLLM, FoodLogParserEntry } from "../coach-ai/food-log-llm";
import {
  brandTokensFromCandidates,
  cleanCalorieName,
  createFallbackFood,
  extractExplicitCalories,
  isRelevantUsdaMatch,
  rankUsdaCandidates,
  usdaMatchTier,
} from "../coach-ai/usda-food-resolver";
import { FoodNutrients } from "../utils/food-database";

function entryWithQueries(queries: string[], quantity = 1, unit = "serving"): FoodLogParserEntry {
  return { new_food_queries: queries, database_food: null, quantity, unit };
}

function usdaFood(overrides: Partial<UsdaFood> = {}): UsdaFood {
  return { fdcId: 1, description: "Test food", ...overrides };
}

function estimatorWith(nutrients: FoodNutrients): FoodLLM {
  return {
    async guessFoodNutrients(): Promise<FoodNutrients> {
      return nutrients;
    },
  } as FoodLLM;
}

test("rejects panda puff cereal for a panda express query", () => {
  const entry = entryWithQueries(["panda express"]);
  const cereal = usdaFood({ description: "Panda puff cereal" });
  assert.equal(isRelevantUsdaMatch(cereal, entry), false);
});

test("accepts a panda express branded match for a panda express query", () => {
  const entry = entryWithQueries(["Panda Express Orange Chicken"]);
  const match = usdaFood({ description: "Orange Chicken", brandOwner: "Panda Express" });
  assert.equal(isRelevantUsdaMatch(match, entry), true);
});

test("accepts an exact food name while rejecting partial-word overlap", () => {
  const entry = entryWithQueries(["chicken breast"]);
  assert.equal(isRelevantUsdaMatch(usdaFood({ description: "Chicken breast" }), entry), true);
  assert.equal(isRelevantUsdaMatch(usdaFood({ description: "Chicken soup" }), entry), false);
});

test("extracts explicit calories from a bar with stated kcal", () => {
  const entry = entryWithQueries(["azxyz bar, 30 kcal"], 1, "bar");
  assert.equal(extractExplicitCalories(entry), 30);
});

test("reads a bare calorie count as explicit calories", () => {
  const entry = entryWithQueries(["20 calories"], 20, "calories");
  assert.equal(extractExplicitCalories(entry), 20);
});

test("strips calorie statements from fallback names", () => {
  assert.equal(cleanCalorieName("azxyz bar, 30 kcal"), "azxyz bar");
  assert.equal(cleanCalorieName("20 calories"), "");
});

test("creates a fallback food with the stated calories and top-ranked unit", async () => {
  const entry = entryWithQueries(["azxyz bar, 30 kcal"], 1, "bar");
  const { food, portion } = await createFallbackFood(entry, estimatorWith({ calories: 999, protein: 2 }));

  assert.deepEqual(food.names, ["azxyz bar"]);
  // 1 bar is estimated as 100 g, so 30 kcal total stays 30 kcal per 100 g.
  assert.equal(food.foodNutrients.calories, 30);
  assert.equal(food.source, "LLM Estimate");
  assert.equal(portion.rank, 1);
  assert.equal(portion.measureUnit?.name, "bar");
  assert.equal(food.foodPortions[0].rank, 1);
});

test("creates an unnamed fallback food for a bare calorie count", async () => {
  const entry = entryWithQueries(["20 calories"], 20, "calories");
  const { food, portion } = await createFallbackFood(entry, estimatorWith({ calories: 5 }));

  assert.deepEqual(food.names, ["Unnamed food"]);
  assert.equal(food.foodNutrients.calories, 20);
  assert.equal(portion.rank, 1);
});

test("accepts generic noodles for panda express noodles when brands are in context", () => {
  const entry = entryWithQueries(["Panda Express Noodles"]);
  const noodles = usdaFood({ fdcId: 11, description: "Noodles" });
  const branded = usdaFood({ fdcId: 12, description: "Chow Mein", brandOwner: "Panda Express" });
  const brands = brandTokensFromCandidates([noodles, branded]);
  assert.ok(brands.has("panda") && brands.has("express"));

  assert.equal(usdaMatchTier(noodles, entry, brands), 1);
  assert.equal(isRelevantUsdaMatch(noodles, entry, brands), true);
});

test("rejects generic noodles without brand context and rejects cereal either way", () => {
  const entry = entryWithQueries(["Panda Express Noodles"]);
  const noodles = usdaFood({ fdcId: 11, description: "Noodles" });
  const cereal = usdaFood({ fdcId: 13, description: "Panda puff cereal" });

  assert.equal(isRelevantUsdaMatch(noodles, entry, new Set()), false);
  assert.equal(isRelevantUsdaMatch(cereal, entry, new Set(["panda", "express"])), false);
});

test("rejects chicken soup for orange chicken: orange is a dish word, not a brand", () => {
  const entry = entryWithQueries(["Orange Chicken"]);
  const soup = usdaFood({ fdcId: 21, description: "Chicken soup" });
  // Even with unrelated restaurant brands in the pool, "orange" is unmatched.
  assert.equal(isRelevantUsdaMatch(soup, entry, new Set(["panda", "express"])), false);
  assert.equal(
    isRelevantUsdaMatch(usdaFood({ fdcId: 22, description: "Orange Chicken" }), entry, new Set()),
    true,
  );
});

test("ranks exact identity first, then unit-rich same-food records, never different foods", () => {
  const entry = entryWithQueries(["Panda Express Noodles"], 2, "cups");
  const brands = new Set(["panda", "express"]);
  const exactFewUnits = usdaFood({
    fdcId: 31,
    description: "Noodles",
    brandOwner: "Panda Express",
    foodPortions: [{ amount: 1, gramWeight: 100, portionDescription: "1 serving", rank: 1 }],
  });
  const genericManyUnits = usdaFood({
    fdcId: 32,
    description: "Noodles",
    foodPortions: [
      { amount: 1, gramWeight: 160, measureUnit: { name: "cup" }, rank: 1 },
      { amount: 1, gramWeight: 28, measureUnit: { name: "oz" }, rank: 2 },
      { amount: 1, gramWeight: 100, portionDescription: "1 serving", rank: 3 },
    ],
  });
  const differentFood = usdaFood({
    fdcId: 33,
    description: "Panda puff cereal",
    foodPortions: [
      { amount: 1, gramWeight: 30, measureUnit: { name: "cup" }, rank: 1 },
      { amount: 1, gramWeight: 100, portionDescription: "1 serving", rank: 2 },
      { amount: 1, gramWeight: 28, measureUnit: { name: "oz" }, rank: 3 },
      { amount: 1, gramWeight: 15, measureUnit: { name: "bowl" }, rank: 4 },
    ],
  });

  const ranked = rankUsdaCandidates([differentFood, genericManyUnits, exactFewUnits], entry, brands);
  assert.deepEqual(ranked.map(candidate => candidate.food.fdcId), [31, 32, 33]);
  assert.equal(ranked[1].hasLoggedUnit, true);
  assert.equal(ranked[2].tier, 2);
});
