import assert from "node:assert/strict";
import test from "node:test";
import { FoodPortion, getFoodPortions, getFoodNutrients } from "../utils/food-database";

test("retains the complete food portion list in logged-food responses", () => {
  const foodPortions: FoodPortion[] = [
    { unit: "1 slice", grams: 107, rank: 1 },
    { unit: "100 grams", grams: 100, rank: 2 },
  ];
  const food = {
    names: ["Pizza"],
    foodNutrients: { calories: 266, protein: 11 },
    foodPortions,
  };

  assert.deepEqual(getFoodNutrients(food), { calories: 266, protein: 11 });
  assert.deepEqual(getFoodPortions(food), foodPortions);
});
