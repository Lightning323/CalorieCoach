import assert from "node:assert/strict";
import test from "node:test";
import { UsdaFood } from "../api/usdaFoodDataApi";
import {
  FoodLLM,
  FoodLogParserEntry,
  FoodMatchCandidate,
} from "../coach-ai/food-log-llm";
import { FoodLogResolver } from "../coach-ai/food-resolver";
import { FoodItem, FoodMetrics } from "../utils/food-database";

const entry: FoodLogParserEntry = {
  food_queries: ["PBH", "peanut butter honey"],
  quantity: 1,
  unit: "serving",
};

const savedPbh: FoodItem = {
  names: ["Peanut Butter Honey", "PBH"],
  quantity: "1 serving",
  metrics: { calories: 180, protein: 7, carbs: 16, fat: 10 },
};

function selectedFoodLlm(
  select: (candidates: readonly FoodMatchCandidate[], source: string) => number | null,
): FoodLLM {
  return {
    async selectBestFoodCandidate(
      _entry: FoodLogParserEntry,
      candidates: readonly FoodMatchCandidate[],
      source: string,
    ): Promise<number | null> {
      const selection = select(candidates, source);
      if (selection !== null) assert.ok(selection >= 0 && selection < candidates.length);
      return selection;
    },
    async guessNutritionalMetrics(): Promise<FoodMetrics> {
      throw new Error("A candidate should have been selected before estimating nutrition.");
    },
  } as unknown as FoodLLM;
}

test("uses the LLM-selected saved food", async () => {
  const unrelatedButSimilar: FoodItem = {
    names: ["PBH Snack Bar"],
    quantity: "1 bar",
    metrics: { calories: 220, protein: 4, carbs: 30, fat: 10 },
  };
  const database = {
    async getAllFoods(): Promise<FoodItem[]> {
      return [unrelatedButSimilar, savedPbh];
    },
  };
  const usda = {
    async getFoodCandidates(): Promise<UsdaFood[]> {
      throw new Error("USDA should not be queried when a saved food is selected.");
    },
    async getFoodById(): Promise<UsdaFood> {
      throw new Error("USDA should not be queried when a saved food is selected.");
    },
  };

  const resolver = new FoodLogResolver(database, selectedFoodLlm(candidates =>
    candidates.findIndex(candidate => candidate.aliases?.includes("PBH")),
  ), usda);
  const result = await resolver.resolve(entry);

  assert.ok(result);
  assert.equal(result.saveFood, false);
  assert.equal(result.food, savedPbh);
});

test("uses the LLM to decline saved foods and select a USDA candidate", async () => {
  const wrongUsdaFood: UsdaFood = {
    fdcId: 1,
    description: "PBH PROTEIN BAR",
    brandName: "Other Brand",
  };
  const selectedUsdaFood: UsdaFood = {
    fdcId: 2,
    description: "PEANUT BUTTER HONEY SPREAD",
    brandName: "PBH Foods",
    foodNutrients: [
      { nutrientId: 1008, amount: 200 },
      { nutrientId: 1003, amount: 8 },
      { nutrientId: 1005, amount: 20 },
      { nutrientId: 1004, amount: 12 },
    ],
  };
  const database = {
    async getAllFoods(): Promise<FoodItem[]> {
      return [{ ...savedPbh, names: ["PBH snack bar"] }];
    },
  };
  const selectedIds: number[] = [];
  const usda = {
    async getFoodCandidates(): Promise<UsdaFood[]> {
      return [wrongUsdaFood, selectedUsdaFood];
    },
    async getFoodById(fdcId: number): Promise<UsdaFood> {
      selectedIds.push(fdcId);
      return selectedUsdaFood;
    },
  };

  const resolver = new FoodLogResolver(database, selectedFoodLlm((candidates, source) => {
    if (source === "saved food profiles") return null;
    return candidates.findIndex(candidate => candidate.name === selectedUsdaFood.description);
  }), usda);
  const result = await resolver.resolve(entry);

  assert.ok(result);
  assert.equal(result.saveFood, true);
  assert.deepEqual(selectedIds, [2]);
  assert.equal(result.food.quantity, "100 grams");
  assert.equal(result.food.metrics?.calories, 200);
  assert.deepEqual(result.portion, {
    amount: 1,
    unit: "serving",
    grams: 100,
    source: "fallback",
  });
});

test("resolves SunChips by their USDA household count and scales nutrients once", async () => {
  const sunChips: UsdaFood = {
    fdcId: 123,
    description: "SunChips original",
    dataType: "Branded",
    servingSize: 28,
    servingSizeUnit: "g",
    householdServingFullText: "15 chips",
    foodNutrients: [
      { nutrientId: 1008, amount: 500 },
      { nutrientId: 1003, amount: 6 },
      { nutrientId: 1005, amount: 64 },
      { nutrientId: 1004, amount: 26 },
    ],
  };
  const resolver = new FoodLogResolver(
    { async getAllFoods(): Promise<FoodItem[]> { return []; } },
    selectedFoodLlm(() => 0),
    {
      async getFoodCandidates(): Promise<UsdaFood[]> { return [sunChips]; },
      async getFoodById(): Promise<UsdaFood> { return sunChips; },
    },
  );

  const result = await resolver.resolve({
    food_queries: ["SunChips"],
    quantity: 20,
    unit: "chip",
  });

  assert.ok(result);
  assert.equal(result.food.quantity, "100 grams");
  assert.equal(result.food.metrics?.calories, 500);
  assert.equal(result.portion?.source, "branded-serving");
  assert.ok(Math.abs((result.portion?.grams ?? 0) - (20 * (28 / 15))) < 1e-12);
  assert.ok(Math.abs(result.quantity - ((20 * (28 / 15)) / 100)) < 1e-12);
  // 500 kcal/100g × 37.333g/100 is ~186.67 kcal, not 20 servings (10,000 kcal).
  assert.ok(Math.abs((result.food.metrics?.calories ?? 0) * result.quantity - (500 * (20 * (28 / 15) / 100))) < 1e-12);
  assert.ok((result.food.metrics?.calories ?? 0) * result.quantity < 1_000);
});

test("keeps explicit mass separate from USDA serving data", async () => {
  const chicken: UsdaFood = {
    fdcId: 456,
    description: "Chicken breast",
    servingSize: 85,
    servingSizeUnit: "g",
    foodNutrients: [
      { nutrientId: 1008, amount: 165 },
      { nutrientId: 1003, amount: 31 },
      { nutrientId: 1005, amount: 0 },
      { nutrientId: 1004, amount: 3.6 },
    ],
  };
  const resolver = new FoodLogResolver(
    { async getAllFoods(): Promise<FoodItem[]> { return []; } },
    selectedFoodLlm(() => 0),
    {
      async getFoodCandidates(): Promise<UsdaFood[]> { return [chicken]; },
      async getFoodById(): Promise<UsdaFood> { return chicken; },
    },
  );

  const grams = await resolver.resolve({ food_queries: ["chicken"], quantity: 150, unit: "g" });
  const ounces = await resolver.resolve({ food_queries: ["chicken"], quantity: 2, unit: "oz" });

  assert.equal(grams?.portion?.grams, 150);
  assert.equal(grams?.portion?.source, "explicit-mass");
  assert.ok(Math.abs((ounces?.portion?.grams ?? 0) - 56.69904625) < 1e-12);
  assert.equal(ounces?.portion?.source, "explicit-mass");
});

test("reuses a canonical saved USDA food while resolving its new portion", async () => {
  const savedSunChips: FoodItem = {
    names: ["SunChips original", "SunChips"],
    quantity: "100 grams",
    metrics: { calories: 500, protein: 6, carbs: 64, fat: 26 },
    source: "USDA FoodData Central",
    sourceId: "789",
  };
  const usdaSunChips: UsdaFood = {
    fdcId: 789,
    description: "SunChips original",
    servingSize: 28,
    servingSizeUnit: "g",
    householdServingFullText: "15 chips",
    foodNutrients: [
      { nutrientId: 1008, amount: 500 },
      { nutrientId: 1003, amount: 6 },
      { nutrientId: 1005, amount: 64 },
      { nutrientId: 1004, amount: 26 },
    ],
  };
  const resolver = new FoodLogResolver(
    { async getAllFoods(): Promise<FoodItem[]> { return [savedSunChips]; } },
    selectedFoodLlm(() => 0),
    {
      async getFoodCandidates(): Promise<UsdaFood[]> {
        throw new Error("A canonical saved USDA food should not require a search.");
      },
      async getFoodById(fdcId: number): Promise<UsdaFood> {
        assert.equal(fdcId, 789);
        return usdaSunChips;
      },
    },
  );

  const result = await resolver.resolve({ food_queries: ["SunChips"], quantity: 20, unit: "chips" });

  assert.ok(result);
  assert.equal(result.saveFood, false);
  assert.equal(result.food, savedSunChips);
  assert.ok(Math.abs((result.portion?.grams ?? 0) - (20 * (28 / 15))) < 1e-12);
  assert.ok(Math.abs(result.quantity - (20 * (28 / 15) / 100)) < 1e-12);
});
