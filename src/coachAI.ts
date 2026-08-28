import { FoodItem, FoodDatabase } from "./utils/food-database";
import { FoodLog } from "./utils/account-database";
import { Accounts } from "./utils/account-database";
import { promptGemini, promptGeminiLite } from "./api/geminiApi";
import {
  getUsdaNutritionPer100g,
  UsdaFoodDataApi,
  UsdaFoodDataApiError,
} from "./api/usdaFoodDataApi";

interface FoodLogParserEntry {
  match_id?: unknown;
  multiplier?: unknown;
  usda_query?: unknown;
  grams?: unknown;
  notes?: unknown;
}

interface ExistingFoodLog extends Omit<FoodLog, "_id" | "logDate" | "foodItem_id" | "backup_foodItem" | "quantity" | "notes"> {
  food: FoodItem;
  quantity: number;
  notes: string;
  saveFood: false;
}

interface NewFoodLog extends Omit<FoodLog, "_id" | "logDate" | "foodItem_id" | "backup_foodItem" | "quantity" | "notes"> {
  food: Omit<FoodItem, "_id">;
  quantity: number;
  notes: string;
  saveFood: true;
}

type ResolvedFoodLog = ExistingFoodLog | NewFoodLog;

const FOOD_LOG_GENERATION_CONFIG = {
  responseMimeType: "application/json",
  temperature: 0,
  maxOutputTokens: 1024,
};

const MAX_MATCH_CANDIDATES = 8;

function readPositiveNumber(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("The food parser returned an invalid quantity.");
  }

  return number;
}

class CoachAIService {
  async test(): Promise<void> {
    console.log(await promptGemini("Hello Gemini!") ?? "Failed to generate prompt");
  }

  private async getCandidateFoods(text: string): Promise<FoodItem[]> {
    return FoodDatabase.searchFoods(text, MAX_MATCH_CANDIDATES, 0.15);
  }

  private buildFoodParserPrompt(text: string, candidates: FoodItem[]): string {
    const candidateList = candidates.length === 0
      ? "No suitable local-food candidates were found."
      : candidates.map((food, index) =>
        `${index}, ${food.name.replace(/"/g, '\\"').replace(",", " ")}, serving: ${food.quantity}`,
      ).join("\n");

    return `Parse this food log into individual food entries: ${JSON.stringify(text)}

Local food candidates (match_id, name, serving):
${candidateList}

Return a JSON array only. Every described food must be one entry using exactly one of these shapes:
- Existing local food: {"match_id": number, "multiplier": number}
- New USDA food: {"usda_query": string, "grams": number}

Rules:
- Use match_id only when a local candidate is clearly the same food. Set multiplier to the number of that candidate's servings.
- Otherwise use usda_query. Make it a specific USDA Foundation or SR Legacy query, such as "chicken breast raw" or "rice white long-grain cooked".
- For a household measure, convert it to grams. For example, one cup of cooked white rice is 158 grams.
- Include every component separately. Never combine ingredients into a meal entry.
- Do not provide or infer calories, protein, carbohydrates, fat, serving nutrition, or any other nutrition values. Gemini is only a text-and-weight parser.
- Do not include markdown, prose, or fields other than the allowed shapes.`;
  }

  private async parseFoodLog(text: string, candidates: FoodItem[]): Promise<FoodLogParserEntry[]> {
    const response = await promptGeminiLite(
      this.buildFoodParserPrompt(text, candidates),
      FOOD_LOG_GENERATION_CONFIG,
    );
    if (!response) throw new Error("Failed to get a food parser response.");

    const parsed: unknown = JSON.parse(response);
    if (!Array.isArray(parsed)) throw new Error("Food parser response was not a list.");
    if (parsed.length === 0) throw new Error("Food parser did not find any food items.");

    return parsed as FoodLogParserEntry[];
  }

  private async resolveFoodLogEntry(
    entry: FoodLogParserEntry,
    candidates: FoodItem[],
  ): Promise<ResolvedFoodLog> {
    if (typeof entry.match_id === "number") {
      const food = candidates[entry.match_id];
      if (!food) throw new Error("Food parser selected an invalid local-food candidate.");

      return {
        food,
        quantity: readPositiveNumber(entry.multiplier, 1),
        notes: typeof entry.notes === "string" ? entry.notes : "",
        saveFood: false,
      };
    }

    const query = typeof entry.usda_query === "string" ? entry.usda_query.trim() : "";
    if (!query) throw new Error("Food parser did not provide a USDA search query.");

    const grams = readPositiveNumber(entry.grams);
    const verifiedFood = await UsdaFoodDataApi.findVerifiedFood(query);
    const nutrition = getUsdaNutritionPer100g(verifiedFood);

    return {
      food: {
        name: verifiedFood.description,
        // FoodData Central's Foundation and SR Legacy nutrient values are per
        // 100 g. The logged quantity below deterministically scales them.
        quantity: "100 grams",
        calories: nutrition.calories,
        protein: nutrition.protein,
        carbs: nutrition.carbs,
        fat: nutrition.fat,
        source: "USDA FoodData Central",
        sourceId: String(verifiedFood.fdcId),
      },
      quantity: grams / 100,
      notes: typeof entry.notes === "string" ? entry.notes : "",
      saveFood: true,
    };
  }

  private getError(error: unknown): string {
    if (error instanceof UsdaFoodDataApiError && error.status === 429) {
      return "USDA food data is temporarily rate-limited. Please try again shortly.";
    }

    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes('"code":429') || message.includes("quota")) {
      return "The food parser is temporarily rate-limited. Please try again shortly.";
    }

    console.error("Unable to log food:", error);
    return `Error logging food: ${message}`;
  }

  async logFood(username: string, foodItemsText: string): Promise<string> {
    if (!foodItemsText || foodItemsText.trim().length === 0) return "No food items provided.";

    try {
      const startedAt = performance.now();
      const candidates = await this.getCandidateFoods(foodItemsText.toLowerCase());
      const parsed = await this.parseFoodLog(foodItemsText, candidates);
      const resolved = await Promise.all(
        parsed.map(entry => this.resolveFoodLogEntry(entry, candidates)),
      );

      const savedFoods = await FoodDatabase.addFoods(
        resolved
          .filter((entry): entry is NewFoodLog => entry.saveFood)
          .map(entry => entry.food),
      );

      let savedFoodIndex = 0;
      const results: Array<Omit<FoodLog, "_id" | "logDate">> = resolved.map(entry => {
        const food = entry.saveFood ? savedFoods[savedFoodIndex++] : entry.food;

        return {
          foodItem_id: food._id,
          backup_foodItem: food,
          quantity: entry.quantity,
          notes: entry.notes,
        };
      });

      await Accounts.addFoodLogs(username, results);
      console.log(`Logged ${results.length} USDA-backed food item(s) in ${(performance.now() - startedAt).toFixed(0)}ms`);
      return `Successfully logged ${results.length} items`;
    } catch (error) {
      return this.getError(error);
    }
  }
}

export const CoachAI = new CoachAIService();
