import assert from "node:assert/strict";
import test from "node:test";
import { scaleFoodNutrientsPer100g } from "../coach-ai/types";

test("scales USDA nutrients from per 100 g to the parsed portion weight", () => {
  const foodNutrients = scaleFoodNutrientsPer100g({
    calories: 268,
    protein: 17.9,
    carbs: 3.57,
    fat: 19.6,
  }, 60);

  assert.ok(Math.abs((foodNutrients.calories ?? 0) - 160.8) < 1e-9);
  assert.ok(Math.abs((foodNutrients.protein ?? 0) - 10.74) < 1e-9);
  assert.equal(foodNutrients.carbs, 2.142);
  assert.equal(foodNutrients.fat, 11.76);
});
