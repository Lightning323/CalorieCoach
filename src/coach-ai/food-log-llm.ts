import { generateJson } from "../api/llmApi";
import { FoodItem, FoodNutrients } from "../utils/food-database";

export interface FoodLogParserEntry {
  new_food_queries: string[];
  database_food: FoodItem | null;
  quantity: number;
  unit: string;
}


export class FoodLLM {




  async guessFoodNutrients(entry: FoodLogParserEntry): Promise<FoodNutrients> {
    const foodDescription = entry.new_food_queries[0] ?? "unknown food";
    const prompt = `Estimate the nutritional content for a typical serving of "${foodDescription}". The portion size is: ${entry.quantity} ${entry.unit}.

Return a JSON object with estimated food nutrients for this portion. Include common nutrients:
- calories (in kcal)
- protein (in grams)
- carbohydrates (in grams)
- fat (in grams)
- fiber (in grams)
- sodium (in mg)

Provide reasonable estimates based on typical nutritional databases. If uncertain, provide conservative estimates.
Return ONLY valid JSON in this format: {"calories": number, "protein": number, "carbohydrates": number, "fat": number, "fiber": number, "sodium": number}`;

    try {
      const foodNutrients = await generateJson(prompt);
      return foodNutrients as unknown as FoodNutrients;
    } catch (error) {
      console.warn(`Failed to guess food nutrients for "${foodDescription}":`, error);
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
