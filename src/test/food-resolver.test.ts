import assert from "node:assert/strict";
import test from "node:test";
import { UsdaFood } from "../api/usdaFoodDataApi";
import { FoodLogResolver } from "../coach-ai/food-resolver";
import { FoodItem, FoodSearchCandidate } from "../utils/food-database";

const savedPbh: FoodItem = {
  names: ["PBH", "Peanut Butter Honey"],
  quantity: "1 serving",
  metrics: { calories: 180, protein: 7, carbs: 16, fat: 10 },
};

function verifiedUsdaFood(): UsdaFood {
  return {
    fdcId: 42,
    description: "PBH substitute",
    foodNutrients: [
      { nutrientId: 1008, amount: 180 },
      { nutrientId: 1003, amount: 7 },
      { nutrientId: 1005, amount: 16 },
      { nutrientId: 1004, amount: 10 },
    ],
  };
}

test("uses a saved food for an individual parsed entry before querying USDA", async () => {
  const searchCalls: string[] = [];
  let usdaCalls = 0;
  const database = {
    async searchFoodCandidates(query: string): Promise<FoodSearchCandidate[]> {
      searchCalls.push(query);
      return [{ item: savedPbh, confidence: 1 }];
    },
  };
  const usda = {
    async findVerifiedFood(): Promise<UsdaFood> {
      usdaCalls += 1;
      return verifiedUsdaFood();
    },
  };
  const resolver = new FoodLogResolver(database, usda);

  const result = await resolver.resolve(
    { food_query: "pbh", quantity: 1, unit: "serving" },
  );

  assert.deepEqual(searchCalls, ["pbh"]);
  assert.equal(usdaCalls, 0);
  assert.equal(result.saveFood, false);
  assert.equal(result.food, savedPbh);
  assert.equal(result.quantity, 1);
});

test("does not apply a non-exact saved serving to an incompatible requested unit", async () => {
  let usdaCalls = 0;
  const database = {
    async searchFoodCandidates(): Promise<FoodSearchCandidate[]> {
      return [{ item: { ...savedPbh, names: ["PBH snack"], quantity: "1 slice" }, confidence: 1 }];
    },
  };
  const usda = {
    async findVerifiedFood(): Promise<UsdaFood> {
      usdaCalls += 1;
      return verifiedUsdaFood();
    },
  };
  const resolver = new FoodLogResolver(database, usda);

  const result = await resolver.resolve(
    { food_query: "pbh", quantity: 100, unit: "g" },
  );

  assert.equal(usdaCalls, 1);
  assert.equal(result.saveFood, true);
});

test("uses an exact saved alias even when a legacy parser response omits the unit", async () => {
  let usdaCalls = 0;
  const database = {
    async searchFoodCandidates(): Promise<FoodSearchCandidate[]> {
      return [{ item: savedPbh, confidence: 1 }];
    },
  };
  const usda = {
    async findVerifiedFood(): Promise<UsdaFood> {
      usdaCalls += 1;
      return verifiedUsdaFood();
    },
  };
  const resolver = new FoodLogResolver(database, usda);

  const result = await resolver.resolve(
    { usda_query: "pbh" },
  );

  assert.equal(usdaCalls, 0);
  assert.equal(result.saveFood, false);
  assert.equal(result.quantity, 1);
});
