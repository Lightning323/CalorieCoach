import assert from "node:assert/strict";
import test from "node:test";
import { isValidDateKey, multiplyFoodMetrics, toNutritionTotals } from "../services/nutrition-service";
import { FoodItem } from "../utils/food-database";

test("validates real ISO date keys instead of only their shape", () => {
  assert.equal(isValidDateKey("2026-02-28"), true);
  assert.equal(isValidDateKey("2024-02-29"), true);
  assert.equal(isValidDateKey("2026-02-29"), false);
  assert.equal(isValidDateKey("2026-2-28"), false);
  assert.equal(isValidDateKey("not-a-date"), false);
});

test("scales a food's complete nutrition profile by its logged quantity", () => {
  const food: FoodItem = {
    names: ["Pizza slice"],
    quantity: "1 slice",
    metrics: { calories: 285, protein: 12, carbs: 36, fat: 10, sodium: 640 },
  };

  assert.deepEqual(multiplyFoodMetrics(food, 2), {
    calories: 570,
    protein: 24,
    carbs: 72,
    fat: 20,
    sodium: 1280,
  });
  assert.deepEqual(multiplyFoodMetrics(null, 2), {});
});

test("continues to calculate nutrition for legacy food records", () => {
  const legacyFood: FoodItem = {
    names: ["Legacy candy"],
    quantity: "1 candy",
    calories: 40,
    protein: 0.2,
    carbs: 9,
    fat: 0.5,
  };

  assert.deepEqual(multiplyFoodMetrics(legacyFood, 3), {
    calories: 120,
    protein: 0.6000000000000001,
    carbs: 27,
    fat: 1.5,
  });
});

test("limits displayed daily totals to the dashboard nutrients", () => {
  assert.deepEqual(toNutritionTotals({ calories: 500, protein: 30, fiber: 8 }), {
    calories: 500,
    protein: 30,
    carbs: 0,
    fat: 0,
  });
});
