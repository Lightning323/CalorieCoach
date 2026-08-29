import assert from "node:assert/strict";
import test from "node:test";
import FoodController from "../controllers/foodController";
import { FoodMetrics } from "../utils/food-database";

interface TestableFoodController {
  readFoodNames(value: unknown): string[];
  readMetrics(suppliedMetrics: unknown, legacyMetrics: Record<string, unknown>): FoodMetrics;
}

function controller(): TestableFoodController {
  return new FoodController() as unknown as TestableFoodController;
}

test("accepts a multi-name food while preserving its first display spelling", () => {
  assert.deepEqual(controller().readFoodNames([
    "  Peach Jamba  ",
    "peach jamba",
    "Jamba Caribbean Passion",
  ]), ["Peach Jamba", "Jamba Caribbean Passion"]);
});

test("requires at least one non-empty text food name", () => {
  for (const names of [undefined, [], [""], [12], new Array(21).fill("apple")]) {
    assert.throws(
      () => controller().readFoodNames(names),
      /food name|required|text/i,
    );
  }
});

test("accepts numeric nutrient values and rejects unsafe nutrient input", () => {
  assert.deepEqual(controller().readMetrics(
    { calories: "200", fiber: 7, sodium: "450", unused: "" },
    { protein: "8", carbs: 30, fat: 4 },
  ), {
    calories: 200,
    fiber: 7,
    sodium: 450,
    protein: 8,
    carbs: 30,
    fat: 4,
  });

  assert.throws(
    () => controller().readMetrics({ "$set": 1 }, {}),
    /Invalid nutrient name/,
  );
  assert.throws(
    () => controller().readMetrics({ calories: "not-a-number" }, {}),
    /must be a number/,
  );
});
