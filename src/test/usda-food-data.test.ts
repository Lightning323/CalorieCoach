import assert from "node:assert/strict";
import test from "node:test";
import {
  foodMatchesUsdaQuery,
  getUsdaFoodNutrientsPer100g,
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
  const foodNutrients = getUsdaFoodNutrientsPer100g(food({
    foodNutrients: [
      { nutrientId: 1008, amount: 250 },
      { nutrient: { id: 1003 }, value: 12.5 },
      { nutrientId: 1005, amount: 30 },
      { nutrient: { id: 1004 }, amount: 8 },
      { nutrientId: 1079, amount: 4 },
    ],
  }));

  assert.deepEqual(foodNutrients, {
    calories: 250,
    protein: 12.5,
    carbs: 30,
    fat: 8,
    fiber: 4,
  });
});

test("rejects USDA details that omit a required core nutrient", () => {
  assert.throws(
    () => getUsdaFoodNutrientsPer100g(food({
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

test("returns USDA candidates for the LLM without hard string-match filtering", async () => {
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
  const api = new UsdaFoodDataApiService() as unknown as {
    searchFoods: (query: string, options?: UsdaSearchOptions) => Promise<UsdaSearchResponse>;
    getFoodCandidates: (query: string, maxResults?: number) => Promise<UsdaFood[]>;
  };
  const searchOptions: UsdaSearchOptions[] = [];
  api.searchFoods = async (_query, options) => {
    searchOptions.push(options ?? {});
    return options?.dataType?.includes("Branded")
      ? searchResponse([v8])
      : searchResponse([jambaSearchResult]);
  };

  const candidates = await api.getFoodCandidates("peach jamba", 10);

  assert.deepEqual(candidates.map(candidate => candidate.fdcId), [1, 2]);
  assert.equal(searchOptions.length, 2);
  assert.ok(searchOptions.every(options => options.requireAllWords === false));
});
