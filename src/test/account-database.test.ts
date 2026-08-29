import assert from "node:assert/strict";
import test from "node:test";
import { foodLogToString, normalizeDailyNutritionTotal } from "../utils/account-database";

test("normalizes modern, partial, and legacy daily nutrition totals", () => {
  assert.deepEqual(normalizeDailyNutritionTotal(350), {
    calories: 350,
    carbs: 0,
    protein: 0,
    fat: 0,
  });
  assert.deepEqual(normalizeDailyNutritionTotal({ calories: 120, protein: 4 }), {
    calories: 120,
    carbs: 0,
    protein: 4,
    fat: 0,
  });
  assert.deepEqual(normalizeDailyNutritionTotal(), {
    calories: 0,
    carbs: 0,
    protein: 0,
    fat: 0,
  });
});

test("formats resolved portions for food-log diagnostics", () => {
  const formatted = foodLogToString({
    quantity: 2,
    notes: "Lunch",
    portion: {
      amount: 2,
      unit: "slice",
      grams: 214,
      source: "usda-food-portion",
    },
  });

  assert.match(formatted, /Quantity: 2 slice \(214 g\)/);
  assert.match(formatted, /Notes: Lunch/);
});
