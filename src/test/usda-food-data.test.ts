import assert from "node:assert/strict";
import test from "node:test";
import {
  foodMatchesUsdaQuery,
  getUsdaMetricsPer100g,
  getUsdaSearchTerms,
  UsdaFood,
  UsdaFoodDataApiError,
  UsdaFoodDataApiService,
  UsdaSearchOptions,
  UsdaSearchResponse,
} from "../api/usdaFoodDataApi";

function food(overrides: Partial<UsdaFood> = {}): UsdaFood {
  return { fdcId: 42, description: "Test food", ...overrides };
}

test("extracts configured USDA nutrients from both detail response shapes", () => {
  const metrics = getUsdaMetricsPer100g(food({
    foodNutrients: [
      { nutrientId: 1008, amount: 250 },
      { nutrient: { id: 1003 }, value: 12.5 },
      { nutrientId: 1005, amount: 30 },
      { nutrient: { id: 1004 }, amount: 8 },
      { nutrientId: 1079, amount: 4 },
    ],
  }));

  assert.deepEqual(metrics, {
    calories: 250,
    protein: 12.5,
    carbs: 30,
    fat: 8,
    fiber: 4,
  });
});

test("rejects USDA details that omit a required core nutrient", () => {
  assert.throws(
    () => getUsdaMetricsPer100g(food({
      foodNutrients: [
        { nutrientId: 1008, amount: 20 },
        { nutrientId: 1003, amount: 1 },
        { nutrientId: 1005, amount: 3 },
      ],
    })),
    error => error instanceof UsdaFoodDataApiError && /fat/.test(error.message),
  );
});

test("removes logging and portion words from mandatory USDA search terms", () => {
  assert.deepEqual(getUsdaSearchTerms("Log 2 slices of peach Jamba today"), ["peach", "jamba"]);
  assert.deepEqual(getUsdaSearchTerms("2 cups"), []);
});

test("requires each meaningful term to be represented in USDA metadata", () => {
  const jamba = food({
    description: "Caribbean Passion Mango Peach Smoothie",
    brandOwner: "Jamba Juice Company",
    ingredients: "Mango, peach, strawberry",
  });
  const v8 = food({
    description: "V8 Splash Peach Mango Smoothie",
    brandName: "V8",
  });

  assert.equal(foodMatchesUsdaQuery(jamba, "peach jamba"), true);
  assert.equal(foodMatchesUsdaQuery(v8, "peach jamba"), false);
  assert.equal(foodMatchesUsdaQuery(jamba, "banana jamba"), false);
});

function searchResponse(foods: UsdaFood[]): UsdaSearchResponse {
  return { foods, totalHits: foods.length, currentPage: 1, totalPages: 1 };
}

test("keeps searching USDA candidates without substituting a different brand", async () => {
  const v8 = food({
    fdcId: 1,
    description: "V8 Splash Smoothies, Peach Mango",
    brandName: "V8",
    dataType: "Branded",
  });
  const jambaSearchResult = food({
    fdcId: 2,
    description: "Caribbean Passion Peach Smoothie",
    brandName: "Jamba",
    dataType: "Branded",
  });
  const verifiedJamba = food({
    ...jambaSearchResult,
    foodNutrients: [
      { nutrientId: 1008, amount: 120 },
      { nutrientId: 1003, amount: 2 },
      { nutrientId: 1005, amount: 28 },
      { nutrientId: 1004, amount: 0.5 },
    ],
  });
  const api = new UsdaFoodDataApiService() as unknown as {
    searchFoods: (query: string, options?: UsdaSearchOptions) => Promise<UsdaSearchResponse>;
    getFoodById: (fdcId: number) => Promise<UsdaFood>;
    findVerifiedFood: (query: string) => Promise<UsdaFood>;
  };
  const queries: string[] = [];
  api.searchFoods = async query => {
    queries.push(query);
    if (query === "jamba") return searchResponse([jambaSearchResult]);
    return searchResponse([v8]);
  };
  api.getFoodById = async fdcId => {
    assert.equal(fdcId, 2);
    return verifiedJamba;
  };

  const result = await api.findVerifiedFood("peach jamba");

  assert.equal(result.fdcId, 2);
  assert.ok(queries.includes("jamba"));
  assert.ok(!queries.includes("v8"));
});

test("fails clearly instead of accepting an unrelated USDA result", async () => {
  const api = new UsdaFoodDataApiService() as unknown as {
    searchFoods: () => Promise<UsdaSearchResponse>;
    findVerifiedFood: (query: string) => Promise<UsdaFood>;
  };
  api.searchFoods = async () => searchResponse([
    food({ description: "V8 Splash Smoothies, Peach Mango", brandName: "V8" }),
  ]);

  await assert.rejects(
    () => api.findVerifiedFood("peach jamba"),
    error => error instanceof UsdaFoodDataApiError && /not find a food/.test(error.message),
  );
});
