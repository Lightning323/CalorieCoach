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
  grams: 50,
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
  assert.equal(result.food.metrics?.calories, 100);
});
