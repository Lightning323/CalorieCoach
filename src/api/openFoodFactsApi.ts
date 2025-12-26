// Define the interface for the food item we want to return
import { FoodItem } from "../utils/food-database";

export interface QueryResult {
  name: string;
  serving_size?: string;
  calories?: number;
  calories_per_100g?: number;
  calories_per_serving?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
}

// Open Food Facts API
// https://world.openfoodfacts.org/data
const USER_AGENT = "CalorieCoach/1.0 (lightning323)";

export class OpenFoodFactsApiService {

  async getAPIFoodMatches(foodItems: string[], maxResults = 4): Promise<Record<string, FoodItem[]>> {
    const matches = await this.getTopQueryResults_Parallel(foodItems, maxResults);
    const result: Record<string, FoodItem[]> = {};

    // Iterate over each query
    Object.entries(matches).forEach(([key, value]) => {
      if (value.length === 0) {
        result[key] = []; // no matches
      } else {
        var arr: FoodItem[] = []

        for (let i = 0; i < value.length; i++) {
          const match = value[i];
          arr.push({
            name: match.name,
            quantity: match.serving_size ?? "1",
            calories: match.calories_per_serving ?? match.calories ?? 0,
            protein: match.protein ?? 0,
            carbs: match.carbs ?? 0,
            fat: match.fat ?? 0,
          });
        }

        result[key] = arr
      }
    });
    return result;
  }



  async getTopQueryResults_Parallel(
    foodItems: string[],
    maxResults = 4
  ): Promise<Record<string, QueryResult[]>> {
    // Map each food item to a promise of results
    const queries = foodItems.map(item =>
      OpenFoodFactsApi.getTopQueryResults(item, maxResults)
    );

    // Run all searches in parallel
    const resultsArray = await Promise.all(queries);

    // Build a map from food item -> results
    const resultMap: Record<string, QueryResult[]> = {};
    foodItems.forEach((item, index) => {
      resultMap[item] = resultsArray[index];
    });

    return resultMap;
  }

  // Class method
  async getTopQueryResults(query: string, topN: number): Promise<QueryResult[]> {
    try {
      const res = await fetch(
        `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
          query
        )}&search_simple=1&action=process&json=1&sort_by=unique_scans_n&page_size=${topN + 5}`,
        {
          headers: {
            "User-Agent": USER_AGENT,
          },
        }
      );

      // Define API response typing
      type ApiProduct = {
        product_name: string;
        nutriments: { [key: string]: any };
        serving_size?: string;
      };

      type ApiResponse = {
        products: ApiProduct[];
      };

      const data: ApiResponse = await res.json();

      // Transform API data into QueryResult[]
      return data.products.map((product) => ({
        name: product.product_name,
        serving_size: product.serving_size,
        calories: this.parseNumberFromString(product.nutriments?.["energy-kcal_100g"]),
        calories_per_100g: this.parseNumberFromString(product.nutriments?.["energy-kcal_100g"]),
        calories_per_serving: this.parseNumberFromString(product.nutriments?.["energy-kcal_serving"]),
        protein: this.parseNumberFromString(product.nutriments?.["proteins_100g"]),
        fat: this.parseNumberFromString(product.nutriments?.["fat_100g"]),
        carbs: this.parseNumberFromString(product.nutriments?.["carbohydrates_100g"]),
      })).filter(
        (item) =>
          item.name &&
          item.serving_size &&
          item.calories_per_serving !== undefined &&
          item.calories_per_serving !== null
      ).slice(0, topN);
    } catch (e) {
      console.log(e);
      return [];
    }
  }

  private parseNumberFromString(str: string): number | null {
    if (!str) return null;
    if(typeof str === 'number') return str;
    
    const cleaned = str.replace(/[^0-9.]/g, "");
    const num = Number(cleaned);
    return Number.isNaN(num) ? null : num;
  }


}

// Export a singleton instance
export const OpenFoodFactsApi = new OpenFoodFactsApiService();


