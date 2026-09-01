import "dotenv/config";
import { REQUIRED_FOOD_METRICS, TRACKED_NUTRIENTS } from "../config";
import { FoodMetrics } from "../utils/food-database";

const USDA_FDC_API_BASE_URL = "https://api.nal.usda.gov/fdc/v1";

export type UsdaFoodDataType =
  | "Branded"
  | "Foundation"
  | "SR Legacy"
  | "Survey (FNDDS)"
  | "Experimental";

export type UsdaSortOrder = "asc" | "desc";

export interface UsdaFoodNutrient {
  nutrientId?: number;
  nutrientName?: string;
  nutrientNumber?: string;
  unitName?: string;
  value?: number;
  amount?: number;
  nutrient?: {
    id?: number;
    name?: string;
    number?: string;
    unitName?: string;
  };
}

export interface UsdaFoodPortion {
  amount?: number;
  gramWeight?: number;
  modifier?: string;
  portionDescription?: string;
  measureUnit?: {
    id?: number;
    name?: string;
    abbreviation?: string;
  };
}

export interface UsdaFood {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  ingredients?: string;
  additionalDescriptions?: string;
  foodCategory?: string | { description?: string };
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodPortions?: UsdaFoodPortion[];
  foodNutrients?: UsdaFoodNutrient[];
  [key: string]: unknown;
}

export interface UsdaSearchOptions {
  pageSize?: number;
  pageNumber?: number;
  dataType?: UsdaFoodDataType[];
  sortBy?: string;
  sortOrder?: UsdaSortOrder;
  brandOwner?: string;
  brandName?: string;
  requireAllWords?: boolean;
}

export interface UsdaSearchResponse {
  foods: UsdaFood[];
  totalHits: number;
  currentPage: number;
  totalPages: number;
  [key: string]: unknown;
}

export interface UsdaListFoodsOptions {
  pageSize?: number;
  pageNumber?: number;
  dataType?: UsdaFoodDataType[];
  sortBy?: string;
  sortOrder?: UsdaSortOrder;
}

export interface UsdaFoodDetailsOptions {
  format?: "abridged" | "full";
  nutrients?: number[];
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "ate", "drink", "drank", "food", "for", "from", "had", "have", "i",
  "in", "is", "item", "it", "just", "like", "log", "me", "my", "of", "on", "please", "some",
  "that", "the", "this", "to", "today", "want", "was", "with", "would",
  "cup", "cups", "g", "gram", "grams", "kg", "lb", "lbs", "mg", "oz", "piece", "pieces",
  "serving", "servings", "slice", "slices", "tablespoon", "tablespoons", "teaspoon", "teaspoons",
]);

function wordsIn(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Significant terms that must appear in a selected USDA result. */
export function getUsdaSearchTerms(query: string): string[] {
  return [...new Set(wordsIn(query).filter(word =>
    !SEARCH_STOP_WORDS.has(word) && !/^\d/.test(word),
  ))];
}

function foodCategoryText(category: UsdaFood["foodCategory"]): string {
  if (typeof category === "string") return category;
  return category?.description ?? "";
}

function wordsForFood(food: UsdaFood): Set<string> {
  return new Set(wordsIn([
    food.description,
    food.brandName,
    food.brandOwner,
    food.ingredients,
    food.additionalDescriptions,
    foodCategoryText(food.foodCategory),
  ].filter((value): value is string => typeof value === "string").join(" ")));
}

/**
 * Identifies whether a food contains all meaningful query terms. This remains
 * available for diagnostics, but candidate acceptance is decided by FoodLLM.
 */
export function foodMatchesUsdaQuery(food: UsdaFood, query: string): boolean {
  const terms = getUsdaSearchTerms(query);
  if (terms.length === 0) return false;

  const foodWords = wordsForFood(food);
  return terms.every(term => foodWords.has(term));
}

export class UsdaFoodDataApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UsdaFoodDataApiError";
  }
}

/**
 * Extracts the configured USDA nutrients reported per 100 g for Foundation
 * and SR Legacy foods. USDA's search response is not complete enough for
 * this, so callers should pass a food obtained from getFoodById().
 */
export function getUsdaMetricsPer100g(food: UsdaFood): FoodMetrics {
  const nutrients = food.foodNutrients ?? [];
  const metrics: FoodMetrics = {};

  for (const [nutrientId, metric] of Object.entries(TRACKED_NUTRIENTS)) {
    const nutrient = nutrients.find(item =>
      item.nutrientId === Number(nutrientId) || item.nutrient?.id === Number(nutrientId),
    );
    const amount = nutrient?.amount ?? nutrient?.value;

    if (typeof amount === "number" && Number.isFinite(amount)) {
      metrics[metric] = amount;
    }
  }

  const missingRequiredMetrics = REQUIRED_FOOD_METRICS.filter(metric => metrics[metric] === undefined);
  if (missingRequiredMetrics.length > 0) {
    throw new UsdaFoodDataApiError(
      `USDA food ${food.fdcId} (${food.description}) does not provide ${missingRequiredMetrics.join(", ")} per 100 g.`,
    );
  }

  return metrics;
}

export class UsdaFoodDataApiService {
  private getApiKey(): string {
    const apiKey = process.env.USDA_API_KEY?.trim();
    if (!apiKey) {
      throw new UsdaFoodDataApiError(
        "USDA_API_KEY must be set in .env before using the USDA FoodData Central API.",
      );
    }

    return apiKey;
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: object;
      query?: Record<string, string | number | undefined>;
    } = {},
  ): Promise<T> {
    const url = new URL(`${USDA_FDC_API_BASE_URL}${path}`);
    url.searchParams.set("api_key", this.getApiKey());

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const details = await response.text();
      console.error("[USDA food lookup] Request failed.", {
        path,
        status: response.status,
        statusText: response.statusText,
        details,
      });
      throw new UsdaFoodDataApiError(
        `USDA FoodData Central request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
        response.status,
      );
    }
    return response.json() as Promise<T>;
  }

  /** Fetches a single food by its FoodData Central ID. */
  async getFoodById(fdcId: number, options: UsdaFoodDetailsOptions = {}): Promise<UsdaFood> {
    this.assertFdcId(fdcId);
    return this.request<UsdaFood>(`/food/${fdcId}`, {
      query: {
        format: options.format,
        nutrients: options.nutrients?.join(","),
      },
    });
  }

  /** Fetches details for multiple FoodData Central IDs in a single request. */
  async getFoodsByIds(
    fdcIds: number[],
    options: UsdaFoodDetailsOptions = {},
  ): Promise<UsdaFood[]> {
    if (fdcIds.length === 0) return [];
    fdcIds.forEach(fdcId => this.assertFdcId(fdcId));

    return this.request<UsdaFood[]>("/foods", {
      method: "POST",
      body: {
        fdcIds,
        ...options,
      },
    });
  }

  /** Returns a paginated list of foods in USDA's abridged format. */
  async listFoods(options: UsdaListFoodsOptions = {}): Promise<UsdaFood[]> {
    return this.request<UsdaFood[]>("/foods/list", {
      method: "POST",
      body: options,
    });
  }

  /** Searches FoodData Central by food name or keywords. */
  async searchFoods(query: string, options: UsdaSearchOptions = {}): Promise<UsdaSearchResponse> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new UsdaFoodDataApiError("A non-empty food search query is required.");
    }
    const response = await this.request<UsdaSearchResponse>("/foods/search", {
      method: "POST",
      body: {
        query: trimmedQuery,
        ...options,
      },
    });
    return response;
  }


  private assertFdcId(fdcId: number) {
    if (!Number.isSafeInteger(fdcId) || fdcId <= 0) {
      throw new UsdaFoodDataApiError("fdcId must be a positive integer.");
    }
  }

  /**
   * Retrieves a small, diverse candidate list for FoodLLM to evaluate. FDC's
   * search rank only shortlists results; it does not decide which food matches.
   */
  async getFoodCandidates(query: string, maxResults = 12): Promise<UsdaFood[]> {
    if (!Number.isSafeInteger(maxResults) || maxResults <= 0 || maxResults > 50) {
      throw new UsdaFoodDataApiError("maxResults must be an integer between 1 and 50.");
    }

    const dataTypes: UsdaFoodDataType[][] = [
      ["Branded"],
      ["Foundation", "SR Legacy", "Survey (FNDDS)", "Experimental"],
    ];
    const searches = await Promise.all(dataTypes.map(dataType => this.searchFoods(query, {
      dataType,
      pageSize: maxResults,
      requireAllWords: false,
    })));
    const candidates = new Map<number, UsdaFood>();
    for (const search of searches) {
      for (const food of search.foods) {
        if (!candidates.has(food.fdcId)) candidates.set(food.fdcId, food);
        if (candidates.size === maxResults) return [...candidates.values()];
      }
    }

    return [...candidates.values()];
  }


}

export const UsdaFoodDataApi = new UsdaFoodDataApiService();
