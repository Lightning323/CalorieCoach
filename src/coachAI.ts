import { FoodItem, FoodDatabase, FoodMetrics, getFoodMetrics } from "./utils/food-database";
import { FoodLog, LoggedFoodPortion } from "./utils/account-database";
import { Accounts } from "./utils/account-database";
import { promptGemini, promptGeminiLite } from "./api/geminiApi";
import {
  getUsdaMetricsPer100g,
  foodMatchesUsdaQuery,
  UsdaFoodDataApi,
  UsdaFoodDataApiError,
} from "./api/usdaFoodDataApi";
import { resolveUsdaFoodPortion } from "./services/food-portion-service";

interface FoodLogParserEntry {
  match_id?: unknown;
  multiplier?: unknown;
  usda_query?: unknown;
  quantity?: unknown;
  unit?: unknown;
  /** Accept old parser responses while the prompt/schema rolls out. */
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

export interface FoodLogProgress {
  progress: number;
  message: string;
}

export interface LoggedFoodEntry {
  id: string;
  loggedAt: string;
  quantity: number;
  portion?: LoggedFoodPortion;
  notes: string;
  food: {
    name: string;
    quantity: string;
    metrics: FoodMetrics;
  };
}

export interface FoodLogResult {
  success: boolean;
  message: string;
  entries: LoggedFoodEntry[];
}

type FoodLogProgressListener = (progress: FoodLogProgress) => void;

const FOOD_LOG_GENERATION_CONFIG = {
  responseMimeType: "application/json",
  temperature: 0,
  maxOutputTokens: 1024,
};

const MAX_MATCH_CANDIDATES = 8;

function scaleFoodMetrics(metrics: FoodMetrics, multiplier: number): FoodMetrics {
  return Object.fromEntries(
    Object.entries(metrics).map(([metric, value]) => [metric, value * multiplier]),
  );
}

function readPositiveNumber(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("The food parser returned an invalid quantity.");
  }

  return number;
}

function readPortionUnit(value: unknown, fallback = "serving"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new Error("The food parser returned an invalid portion unit.");
  }
  return value.trim();
}

class CoachAIService {
  async test(): Promise<void> {
    console.log(await promptGemini("Hello Gemini!") ?? "Failed to generate prompt");
  }

  private async getCandidateFoods(text: string): Promise<FoodItem[]> {
    const candidates = await FoodDatabase.searchFoods(text, MAX_MATCH_CANDIDATES, 0.15);
    // Do not let a previously saved food override a brand or product term in
    // the new entry. For example, a V8 profile is not a local match for Jamba.
    return candidates.filter(food => foodMatchesUsdaQuery({
      fdcId: 1,
      description: `${food.name} ${food.quantity}`,
    }, text));
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
- New USDA food: {"usda_query": string, "quantity": number, "unit": string}

Rules:
- Use match_id only when a local candidate is clearly the same food. Set multiplier to the number of that candidate's servings.
- Otherwise use usda_query. It must preserve every brand, restaurant, product, and flavor qualifier from the person's wording. For example, "peach Jamba" must keep "Jamba" in the query. Never replace a branded or restaurant item with a different brand or a generic product.
- Preserve the amount and measure the person described. For example, "2 slices of pizza" becomes quantity 2 and unit "slice"; "1 candy" becomes quantity 1 and unit "candy"; and "150 g chicken" becomes quantity 150 and unit "g". If no amount is stated, use quantity 1 and unit "serving".
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
    onProgress?: FoodLogProgressListener,
    progress = 55,
  ): Promise<ResolvedFoodLog> {
    if (typeof entry.match_id === "number") {
      const food = candidates[entry.match_id];
      if (!food) throw new Error("Food parser selected an invalid local-food candidate.");

      this.reportProgress(onProgress, progress, `Using saved database entry: ${food.name}.`);

      return {
        food,
        quantity: readPositiveNumber(entry.multiplier, 1),
        notes: typeof entry.notes === "string" ? entry.notes : "",
        saveFood: false,
      };
    }

    const query = typeof entry.usda_query === "string" ? entry.usda_query.trim() : "";
    if (!query) throw new Error("Food parser did not provide a USDA search query.");

    this.reportProgress(onProgress, progress, `Looking up ${query} in USDA FoodData Central.`);
    const verifiedFood = await UsdaFoodDataApi.findVerifiedFood(query);
    const metricsPer100g = getUsdaMetricsPer100g(verifiedFood);
    const amount = entry.quantity === undefined
      ? readPositiveNumber(entry.grams, 1)
      : readPositiveNumber(entry.quantity);
    const unit = entry.quantity === undefined
      ? "g"
      : readPortionUnit(entry.unit);
    const portion = resolveUsdaFoodPortion(verifiedFood, amount, unit);
    this.reportProgress(onProgress, progress + 5, `Verified nutrition for ${verifiedFood.description}.`);
    const description = verifiedFood.description;
    const brand = verifiedFood.brandName ?? verifiedFood.brandOwner;
    const displayName = brand && !description.toLowerCase().includes(brand.toLowerCase())
      ? `${brand}: ${description}`
      : description;
    const titleCase = displayName.toLowerCase()
      .split(" ")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    const gramsPerUnit = portion.grams / portion.amount;
    const metrics = scaleFoodMetrics(metricsPer100g, gramsPerUnit / 100);

    return {
      food: {
        name: titleCase,
        // Store nutrition per entered unit, not per 100 g, so the saved food
        // and dashboard say "1 slice" or "1 candy" rather than "100 grams".
        quantity: `1 ${portion.unit}`,
        metrics,
        source: "USDA FoodData Central",
        sourceId: String(verifiedFood.fdcId),
      },
      quantity: portion.amount,
      portion,
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

  private reportProgress(
    listener: FoodLogProgressListener | undefined,
    progress: number,
    message: string,
  ) {
    listener?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), message });
  }

  async logFood(
    username: string,
    foodItemsText: string,
    onProgress?: FoodLogProgressListener,
  ): Promise<FoodLogResult> {
    if (!foodItemsText || foodItemsText.trim().length === 0) {
      return { success: false, message: "No food items provided.", entries: [] };
    }

    try {
      const startedAt = performance.now();
      this.reportProgress(onProgress, 10, "Searching saved food database for possible matches.");
      const candidates = await this.getCandidateFoods(foodItemsText.toLowerCase());
      this.reportProgress(
        onProgress,
        25,
        candidates.length
          ? `Found ${candidates.length} possible saved food match${candidates.length === 1 ? "" : "es"}.`
          : "No matching saved foods found; new foods will be verified from the source database.",
      );
      this.reportProgress(onProgress, 35, "Sending the food description to the AI parser.");
      const parsed = await this.parseFoodLog(foodItemsText, candidates);
      this.reportProgress(onProgress, 50, `AI identified ${parsed.length} food item${parsed.length === 1 ? "" : "s"}.`);
      const resolved = await Promise.all(
        parsed.map((entry, index) => this.resolveFoodLogEntry(
          entry,
          candidates,
          onProgress,
          55 + ((index / parsed.length) * 20),
        )),
      );

      const newFoods = resolved
        .filter((entry): entry is NewFoodLog => entry.saveFood)
        .map(entry => entry.food);
      this.reportProgress(
        onProgress,
        78,
        newFoods.length
          ? `Saving ${newFoods.length} verified food profile${newFoods.length === 1 ? "" : "s"} to the local database.`
          : "All food profiles were found in the local database.",
      );
      const savedFoods = await FoodDatabase.addFoods(newFoods);

      let savedFoodIndex = 0;
      const foodsForLogs: FoodItem[] = [];
      const results: Array<Omit<FoodLog, "_id" | "logDate">> = resolved.map(entry => {
        const food = entry.saveFood ? savedFoods[savedFoodIndex++] : entry.food;
        foodsForLogs.push(food);

        return {
          foodItem_id: food._id,
          backup_foodItem: food,
          quantity: entry.quantity,
          portion: entry.portion,
          notes: entry.notes,
        };
      });

      this.reportProgress(onProgress, 90, `Adding ${results.length} item${results.length === 1 ? "" : "s"} to today's log.`);
      const savedLogs = await Accounts.addFoodLogs(username, results);
      const entries = savedLogs.map((log, index) => {
        const food = foodsForLogs[index];
        return {
          id: log._id!.toHexString(),
          loggedAt: log.logDate!.toISOString(),
          quantity: log.quantity,
          portion: log.portion,
          notes: log.notes,
          food: {
            name: food.name,
            quantity: food.quantity,
            metrics: getFoodMetrics(food),
          },
        };
      });

      this.reportProgress(onProgress, 100, "Food log saved.");
      console.log(`Logged ${results.length} USDA-backed food item(s) in ${(performance.now() - startedAt).toFixed(0)}ms`);
      return { success: true, message: `Successfully logged ${results.length} items`, entries };
    } catch (error) {
      return { success: false, message: this.getError(error), entries: [] };
    }
  }
}

export const CoachAI = new CoachAIService();
