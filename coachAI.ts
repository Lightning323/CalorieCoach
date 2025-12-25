import { Foods, FoodItem } from "./food-database";

export interface LoggedFoodResult {
  food: FoodItem;
  matchDescription?: string;
  calorieDescription?: string;
}

class CoachAIService {
  /**
   * Log a food based on description and quantity text.
   * @param name Description of the food (e.g., "caramel popcorn")
   * @param quantity Quantity text (e.g., "1 cup")
   */
  async logFood(name: string, quantity: string): Promise<LoggedFoodResult> {
    // Try to find an existing food
    const found = await Foods.findFoodByName(name);

    if (found) {
      // Exact or close match found
      return {
        food: found.item,
        matchDescription: `Matched "${found.item.name}" with confidence ${(
          found.confidence * 100
        ).toFixed(0)}%`,
      };
    }

    // No match found — estimate calories
    const estimatedCalories = this.estimateCalories(name, quantity);

    // Create a new food entry
    const newFood = await Foods.addFood({
      name,
      quantity,
      calories: estimatedCalories,
    });

    return {
      food: newFood,
      calorieDescription: `No match found. Estimated calories as ${estimatedCalories} kcal based on "${quantity}"`,
    };
  }

  /**
   * Simple calorie estimator based on keywords or quantity.
   * For MVP, we just assign a default value.
   */
  private estimateCalories(name: string, quantity: string): number {
    // Here you could integrate a more advanced ML model or API in the future
    return 100; // default placeholder
  }
}

export const CoachAI = new CoachAIService();
