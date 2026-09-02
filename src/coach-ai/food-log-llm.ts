import { generateJson } from "../api/llmApi";
import { keywordSimilarity } from "../utils/utils";
import {
  getUsdaMetricsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
} from "../api/usdaFoodDataApi";
import {
  FoodDatabase,
  FoodItem,
  getFoodNames,
} from "../utils/food-database";


export class FoodLLM {




  async guessNutritionalMetrics(entry: FoodLogParserEntry): Promise<FoodMetrics> {
    const foodDescription = entry.food_queries?.[0] ?? "unknown food";
    const prompt = `Estimate the nutritional content for a typical serving of "${foodDescription}". The portion size is: ${entry.quantity} ${entry.unit}.

Return a JSON object with estimated nutritional metrics for this portion. Include common nutrients:
- calories (in kcal)
- protein (in grams)
- carbohydrates (in grams)
- fat (in grams)
- fiber (in grams)
- sodium (in mg)

Provide reasonable estimates based on typical nutritional databases. If uncertain, provide conservative estimates.
Return ONLY valid JSON in this format: {"calories": number, "protein": number, "carbohydrates": number, "fat": number, "fiber": number, "sodium": number}`;

    try {
      const metrics = await generateJson(prompt);
      return metrics as unknown as FoodMetrics;
    } catch (error) {
      console.warn(`Failed to guess nutritional metrics for "${foodDescription}":`, error);
      // Return default empty metrics if LLM fails
      return {
        calories: 0,
        protein: 0,
        carbohydrates: 0,
        fat: 0,
      };
    }
  }





}
