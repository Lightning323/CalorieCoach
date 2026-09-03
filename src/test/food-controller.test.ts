import assert from "node:assert/strict";
import test from "node:test";
import FoodController from "../controllers/foodController";
import { FoodNutrients, FoodPortion, normalizeFoodPortions } from "../utils/food-database";

interface TestableFoodController {
  readFoodNames(value: unknown): string[];
  readFoodNutrients(value: unknown): FoodNutrients;
  readFoodPortions(value: unknown): FoodPortion[];
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

test("accepts numeric food nutrients and rejects unsafe nutrient input", () => {
  assert.deepEqual(controller().readFoodNutrients(
    { calories: "200", fiber: 7, sodium: "450", unused: "" },
  ), {
    calories: 200,
    fiber: 7,
    sodium: 450,
  });

  assert.throws(
    () => controller().readFoodNutrients({ "$set": 1 }),
    /Invalid nutrient name/,
  );
  assert.throws(
    () => controller().readFoodNutrients({ calories: "not-a-number" }),
    /must be a number/,
  );
});

test("requires USDA-style portions with a unit, grams, and rank", () => {
  assert.deepEqual(controller().readFoodPortions([
    { unit: "1 cup", grams: "240", rank: 2 },
    { unit: "100 grams", grams: 100, rank: 1 },
  ]), [
    { amount: 100, measureUnit: { name: "grams" }, gramWeight: 100, rank: 1 },
    { amount: 1, measureUnit: { name: "cup" }, gramWeight: 240, rank: 2 },
  ]);

  assert.throws(
    () => controller().readFoodPortions([{ unit: "1 cup", grams: 240 }]),
    /rank/i,
  );
});

test("normalizes duplicate portions written using different USDA fields", () => {
  assert.deepEqual(normalizeFoodPortions([
    { amount: 1, gramWeight: 32, portionDescription: "1 serving", rank: 1 },
    { amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 2 },
    { gramWeight: 32, measureUnit: { name: "1 serving" }, rank: 100 },
  ]), [
    { amount: 1, gramWeight: 32, portionDescription: "1 serving", rank: 1 },
    { amount: 100, gramWeight: 100, measureUnit: { name: "gram", abbreviation: "g" }, rank: 2 },
  ]);
});
