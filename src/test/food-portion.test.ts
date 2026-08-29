import assert from "node:assert/strict";
import test from "node:test";
import { foodMatchesUsdaQuery, UsdaFood } from "../api/usdaFoodDataApi";
import { normalizeFoodUnit, resolveUsdaFoodPortion } from "../services/food-portion-service";

function food(overrides: Partial<UsdaFood> = {}): UsdaFood {
  return {
    fdcId: 1,
    description: "Test food",
    ...overrides,
  };
}

test("does not accept V8 as a Jamba peach product", () => {
  assert.equal(foodMatchesUsdaQuery(food({
    description: "Beverages, V8 Splash Smoothies, Peach Mango",
    brandName: "V8",
  }), "peach jamba"), false);
  assert.equal(foodMatchesUsdaQuery(food({
    description: "Peach Perfection Smoothie",
    brandName: "Jamba Juice",
  }), "log 2 slices of peach jamba"), true);
});

test("resolves two pizza slices from USDA foodPortions", () => {
  const portion = resolveUsdaFoodPortion(food({
    foodPortions: [{
      amount: 1,
      gramWeight: 107,
      measureUnit: { name: "slice" },
    }],
  }), 2, "slices");

  assert.deepEqual(portion, {
    amount: 2,
    unit: "slice",
    grams: 214,
    source: "usda-food-portion",
  });
});

test("resolves one branded candy from its household serving size", () => {
  const portion = resolveUsdaFoodPortion(food({
    dataType: "Branded",
    servingSize: 5,
    servingSizeUnit: "g",
    householdServingFullText: "1 candy",
  }), 1, "candy");

  assert.deepEqual(portion, {
    amount: 1,
    unit: "candy",
    grams: 5,
    source: "branded-serving",
  });
});

test("converts explicit grams and common mass units without a USDA portion", () => {
  assert.deepEqual(resolveUsdaFoodPortion(food(), 150, "grams"), {
    amount: 150,
    unit: "g",
    grams: 150,
    source: "explicit-mass",
  });
  assert.equal(resolveUsdaFoodPortion(food(), 2, "oz").grams, 56.69904625);
  assert.equal(resolveUsdaFoodPortion(food(), 1.5, "pounds").grams, 680.388555);
});

test("normalizes common plural and display units", () => {
  assert.equal(normalizeFoodUnit("  of Slices  "), "slice");
  assert.equal(normalizeFoodUnit("berries"), "berry");
  assert.equal(normalizeFoodUnit(""), "serving");
});

test("uses the USDA portion amount when a serving describes multiple units", () => {
  const portion = resolveUsdaFoodPortion(food({
    foodPortions: [{
      amount: 2,
      gramWeight: 60,
      portionDescription: "2 cookies",
    }],
  }), 3, "cookie");

  assert.deepEqual(portion, {
    amount: 3,
    unit: "cookie",
    grams: 90,
    source: "usda-food-portion",
  });
});

test("converts a branded multi-item household serving to one item", () => {
  const portion = resolveUsdaFoodPortion(food({
    dataType: "Branded",
    servingSize: 30,
    servingSizeUnit: "g",
    householdServingFullText: "2 cookies (30g)",
  }), 1, "cookie");

  assert.deepEqual(portion, {
    amount: 1,
    unit: "cookie",
    grams: 15,
    source: "branded-serving",
  });
});

test("rejects zero, negative, and non-finite portion amounts", () => {
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveUsdaFoodPortion(food(), amount, "slice"),
      /positive number/,
    );
  }
});

test("uses 100 g per entered item only when no unit can be resolved", () => {
  const portion = resolveUsdaFoodPortion(food(), 1, "handful");

  assert.deepEqual(portion, {
    amount: 1,
    unit: "handful",
    grams: 100,
    source: "fallback",
  });
  assert.equal(resolveUsdaFoodPortion(food(), 2, "handful").grams, 200);
});
