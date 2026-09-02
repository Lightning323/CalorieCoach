import assert from "node:assert/strict";
import test from "node:test";
import { UsdaFood } from "../api/usdaFoodDataApi";
import { FoodLLM, FoodLogParserEntry } from "../coach-ai/food-log-llm";
import { FoodLogResolver } from "../coach-ai/food-resolver";
import { FoodItem, FoodMetrics } from "../utils/food-database";

const pbh: FoodItem = {
  names: ["Peanut Butter Honey", "PBH"],
  quantity: "1 serving",
  metrics: { calories: 180, protein: 7, carbs: 16, fat: 10 },
};

function parserWithEstimate(metrics: FoodMetrics): FoodLLM {
  return {
    async guessNutritionalMetrics(): Promise<FoodMetrics> {
      return metrics;
    },
  } as FoodLLM;
}

test("uses the parser-selected database food without a USDA search", async () => {
  const resolver = new FoodLogResolver(
    parserWithEstimate({}),
    {
      async getFoodCandidates(): Promise<UsdaFood[]> {
        throw new Error("USDA should not be searched for a database match.");
      },
      async getFoodById(): Promise<UsdaFood> {
        throw new Error("USDA should not be fetched for a database match.");
      },
    },
  );
  const entry: FoodLogParserEntry = {
    new_food_queries: ["PBH"],
    database_food: pbh,
    quantity: 1,
    unit: "serving",
  };

  const [result] = await resolver.resolveAll([entry]);

  assert.ok(result);
  assert.equal(result.food, pbh);
  assert.equal(result.saveFood, false);
});

test("searches USDA only when no database food was selected", async () => {
  const chicken: UsdaFood = {
    fdcId: 456,
    description: "Chicken breast",
    foodNutrients: [
      { nutrientId: 1008, amount: 165 },
      { nutrientId: 1003, amount: 31 },
      { nutrientId: 1005, amount: 0 },
      { nutrientId: 1004, amount: 3.6 },
    ],
  };
  const queries: string[] = [];
  const resolver = new FoodLogResolver(
    parserWithEstimate({}),
    {
      async getFoodCandidates(query): Promise<UsdaFood[]> {
        queries.push(query);
        return [chicken];
      },
      async getFoodById(fdcId): Promise<UsdaFood> {
        assert.equal(fdcId, chicken.fdcId);
        return chicken;
      },
    },
  );
  const entry: FoodLogParserEntry = {
    new_food_queries: ["chicken breast", "chicken"],
    database_food: null,
    quantity: 150,
    unit: "g",
  };

  const [result] = await resolver.resolveAll([entry]);

  assert.deepEqual(queries, ["chicken breast", "chicken"]);
  assert.ok(result);
  assert.equal(result.food.source, "USDA FoodData Central");
  assert.equal(result.food.metrics?.calories, 165);
  assert.equal(result.portion?.grams, 150);
});

test("estimates only when an unmatched entry has no USDA results", async () => {
  const resolver = new FoodLogResolver(
    parserWithEstimate({ calories: 90, protein: 1, carbs: 20, fat: 0 }),
    {
      async getFoodCandidates(): Promise<UsdaFood[]> {
        return [];
      },
      async getFoodById(): Promise<UsdaFood> {
        throw new Error("No USDA food should be fetched.");
      },
    },
  );
  const entry: FoodLogParserEntry = {
    new_food_queries: ["lime fruit strip", "fruit leather"],
    database_food: null,
    quantity: 1,
    unit: "serving",
  };

  const [result] = await resolver.resolveAll([entry]);

  assert.ok(result);
  assert.equal(result.food.source, "LLM Estimate");
  assert.equal(result.food.metrics?.calories, 90);
  assert.equal(result.saveFood, true);
});
