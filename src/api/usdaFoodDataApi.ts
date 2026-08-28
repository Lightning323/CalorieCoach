import "dotenv/config";

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
}

export interface UsdaFood {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  servingSize?: number;
  servingSizeUnit?: string;
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

export class UsdaFoodDataApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UsdaFoodDataApiError";
  }
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
      query: { format: options.format },
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

    return this.request<UsdaSearchResponse>("/foods/search", {
      method: "POST",
      body: {
        query: trimmedQuery,
        ...options,
      },
    });
  }

  private assertFdcId(fdcId: number) {
    if (!Number.isSafeInteger(fdcId) || fdcId <= 0) {
      throw new UsdaFoodDataApiError("fdcId must be a positive integer.");
    }
  }
}

export const UsdaFoodDataApi = new UsdaFoodDataApiService();
