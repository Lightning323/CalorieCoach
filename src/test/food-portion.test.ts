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

test("distinguishes a count of chips from a count of servings", () => {
  const sunChips = food({
    dataType: "Branded",
    servingSize: 28,
    servingSizeUnit: "g",
    householdServingFullText: "15 chips",
  });

  const twentyChips = resolveUsdaFoodPortion(sunChips, 20, "chips");
  assert.equal(twentyChips.source, "branded-serving");
  assert.ok(Math.abs(twentyChips.grams - (20 * (28 / 15))) < 1e-12);

  const oneChip = resolveUsdaFoodPortion(sunChips, 1, "chip");
  assert.ok(Math.abs(oneChip.grams - (28 / 15)) < 1e-12);

  assert.deepEqual(resolveUsdaFoodPortion(sunChips, 1, "serving"), {
    amount: 1,
    unit: "serving",
    grams: 28,
    source: "branded-serving",
  });
  assert.equal(resolveUsdaFoodPortion(sunChips, 2, "servings").grams, 56);
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

test("derives a chip weight from a multi-chip USDA foodPortion", () => {
  const portion = resolveUsdaFoodPortion(food({
    foodPortions: [{
      amount: 15,
      gramWeight: 28,
      measureUnit: { name: "chips" },
    }],
  }), 20, "chip");

  assert.equal(portion.source, "usda-food-portion");
  assert.ok(Math.abs(portion.grams - (20 * (28 / 15))) < 1e-12);
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

test("uses one explicit 100 g fallback when no portion can be resolved", () => {
  const portion = resolveUsdaFoodPortion(food(), 1, "handful");

  assert.deepEqual(portion, {
    amount: 1,
    unit: "handful",
    grams: 100,
    source: "fallback",
  });
  assert.deepEqual(resolveUsdaFoodPortion(food(), 20, "chips"), {
    amount: 20,
    unit: "chip",
    grams: 100,
    source: "fallback",
  });
});
