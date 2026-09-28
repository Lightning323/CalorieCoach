import assert from "node:assert/strict";
import test from "node:test";
import { FoodPortion, getFoodPortions, getFoodNutrients } from "../utils/food-database";

test("retains the complete food portion list in logged-food responses", () => {
  const foodPortions: FoodPortion[] = [
    { amount: 1, gramWeight: 107, measureUnit: { name: "slice" }, rank: 1 },
    { amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 2 },
  ];
  const food = {
    names: ["Pizza"],
    foodNutrients: { calories: 266, protein: 11 },
    foodPortions,
  };

  assert.deepEqual(getFoodNutrients(food), { calories: 266, protein: 11 });
  assert.deepEqual(getFoodPortions(food), foodPortions);
});
