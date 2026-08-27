import { FoodItem, FoodDatabase } from "./utils/food-database";
import { FoodLog } from "./utils/account-database";
import { Accounts } from "./utils/account-database";
import { promptGemini, promptGeminiLite } from "./api/geminiApi";

export interface FoodItemAI {
  name: string;
  estimatedCalories: number;
  quantity: string;
  unit?: string;
}

interface FoodLogResponseEntry {
  match_id?: unknown;
  multiplier?: unknown;
  notes?: unknown;
  is_unidentified?: unknown;
  new_food?: {
    name?: unknown;
    serving_size?: unknown;
    calories?: unknown;
    protein?: unknown;
    carbs?: unknown;
    fat?: unknown;
  };
}

const FOOD_LOG_GENERATION_CONFIG = {
  responseMimeType: "application/json",
  temperature: 0,
  maxOutputTokens: 2048,
};

const MAX_MATCH_CANDIDATES = 8;

function toFiniteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class CoachAIService {
  async test(): Promise<void> {
    console.log(await promptGemini("Hello Gemini!") ?? "Failed to generate prompt");
  }

  async getIndividualFoodItems(foodItemsText?: string): Promise<FoodItemAI[]> {
    const prompt =
      `List the following food item(s) in CSV format (name,estimatedCalories,quantity,unit): "${foodItemsText}". Use singular, correct names (e.g., "cup of joe" → "coffee"). Respond with CSV ONLY.`;

    let response = await promptGeminiLite(prompt);
    if (!response) return [];

    response = response.replace(/```csv/i, "").replace(/```/g, "").trim();
    return response.split("\n").map(line => {
      const values = line.split(",");
      return {
        name: values[0],
        estimatedCalories: Number(values[1]),
        quantity: values[2],
        unit: values[3] ?? undefined,
      };
    });
  }

  async simplePromptPiece(text: string): Promise<{ prompt: string; allMatches: FoodItem[] }> {
    let prompt = `Food description: "${text}"\n`;

    // A small, high-confidence candidate set is enough for matching while
    // avoiding a large prompt that slows every logging request.
    const allMatches = await FoodDatabase.searchFoods(text, MAX_MATCH_CANDIDATES, 0.15);

    if (allMatches.length === 0) {
      prompt += "No database matches found.\n";
    } else {
      prompt += "Database candidates (match_id, name, serving_size, calories, protein, carbs, fat):\n";
      for (const [index, food] of allMatches.entries()) {
        prompt += `${index}, ${food.name.replace(/"/g, '\\"').replace(",", " ")}, ${food.quantity}, ${food.calories}, ${food.protein ?? 0}, ${food.carbs ?? 0}, ${food.fat ?? 0}\n`;
      }
    }

    return { prompt, allMatches };
  }

  private getError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    if (msg.includes('"code":429') || msg.includes("429") || msg.includes("quota")) {
      console.warn("Gemini rate limit hit");
      return "AI is temporarily unavailable (rate limit exceeded). Please try again later.";
    }

    console.error(msg);
    return "Error logging food: " + msg;
  }

  private async logBestDatabaseMatch(
    username: string,
    allMatches: FoodItem[],
    error: unknown,
  ): Promise<string> {
    if (allMatches.length === 0) return this.getError(error);

    const food = allMatches[0];
    await Accounts.addFoodLogs(username, [{
      foodItem_id: food._id,
      backup_foodItem: food,
      quantity: 1,
      notes: "",
    }]);

    return "Logged 1 items with errors:\n" + this.getError(error);
  }

  async logFood(username: string, foodItemsText: string): Promise<string> {
    if (!foodItemsText || foodItemsText.trim().length === 0) return "No food items provided.";

    try {
      const startedAt = performance.now();
      const { prompt: candidatePrompt, allMatches } = await this.simplePromptPiece(
        foodItemsText.replace(/"/g, '\\"').toLowerCase(),
      );
      const prompt = `${candidatePrompt}
Return a JSON array only. Log every described item with accurate calories, protein, carbs, fat, serving size, and multiplier.
- Use a database candidate when it is a good match: {"match_id": number, "multiplier": number}.
- Otherwise create it: {"new_food":{"name":string,"serving_size":string,"calories":number,"protein":number,"carbs":number,"fat":number},"multiplier":number}.
- For an unnamed item such as "260 calories", use new_food with an empty name.
- Include a multiplier for every entry; use 1 when unspecified.
- Do not include markdown or commentary.`;

      let parsed: FoodLogResponseEntry[];
      try {
        // Flash Lite is materially faster for extraction. promptGeminiLite
        // retries with Flash automatically if Lite is unavailable.
        const response = await promptGeminiLite(prompt, FOOD_LOG_GENERATION_CONFIG);
        if (!response) return "Failed to get Gemini response";

        parsed = JSON.parse(response);
        if (!Array.isArray(parsed)) throw new Error("AI response was not a food list");
      } catch (error) {
        console.warn("AI food parsing failed; using the closest database match.", error);
        return this.logBestDatabaseMatch(username, allMatches, error);
      }

      try {
        const newFoods: Array<{ responseIndex: number; food: Omit<FoodItem, "_id"> }> = [];
        const foodItems: Array<FoodItem | undefined> = new Array(parsed.length);

        for (const [responseIndex, entry] of parsed.entries()) {
          if (entry.new_food) {
            const newFood = entry.new_food;
            if (newFood.calories == null) continue;

            const name = typeof newFood.name === "string" ? newFood.name.trim() : "";
            const food: Omit<FoodItem, "_id"> = {
              name: name || "Unlabeled Food",
              quantity: typeof newFood.serving_size === "string" && newFood.serving_size.trim()
                ? newFood.serving_size
                : "1 unit",
              calories: toFiniteNumber(newFood.calories),
              protein: toFiniteNumber(newFood.protein),
              carbs: toFiniteNumber(newFood.carbs),
              fat: toFiniteNumber(newFood.fat),
            };

            if (entry.is_unidentified !== true && name) {
              newFoods.push({ responseIndex, food });
            } else {
              foodItems[responseIndex] = food;
            }
          } else if (typeof entry.match_id === "number" && entry.match_id >= 0 && allMatches[entry.match_id]) {
            foodItems[responseIndex] = allMatches[entry.match_id];
          }
        }

        // Insert all new foods in one database call, then append every log in
        // one atomic account update instead of waiting on each item in series.
        const savedFoods = await FoodDatabase.addFoods(newFoods.map(({ food }) => food));
        for (const [index, food] of savedFoods.entries()) {
          foodItems[newFoods[index].responseIndex] = food;
        }

        const results: Array<Omit<FoodLog, "_id" | "logDate">> = [];
        for (const [index, entry] of parsed.entries()) {
          const food = foodItems[index];
          if (!food) continue;

          results.push({
            foodItem_id: food._id,
            backup_foodItem: food,
            quantity: toFiniteNumber(entry.multiplier, 1),
            notes: typeof entry.notes === "string" ? entry.notes : "",
          });
        }

        if (results.length === 0) return "No recognizable food items found.";

        await Accounts.addFoodLogs(username, results);
        console.log(`Logged ${results.length} food item(s) in ${(performance.now() - startedAt).toFixed(0)}ms`);
        return `Successfully logged ${results.length} items`;
      } catch (error) {
        return this.getError(error);
      }
    } catch (error) {
      return this.getError(error);
    }
  }
}

export const CoachAI = new CoachAIService();
