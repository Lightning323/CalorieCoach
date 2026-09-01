import { UsdaFoodDataApiError } from "../api/usdaFoodDataApi";
import { Accounts, FoodLog } from "../utils/account-database";
import { FoodDatabase, FoodItem, getFoodMetrics, getFoodNames } from "../utils/food-database";
import { FoodLogParser } from "./food-log-parser";
import { FoodLogResolver } from "./food-resolver";
import {
  FoodLogProgressListener,
  FoodLogResult,
  NewFoodLog,
  ResolvedFoodLog,
  reportProgress,
} from "./types";

function userFacingError(error: unknown): string {
  if (error instanceof UsdaFoodDataApiError && error.status === 429) {
    return "USDA food data is temporarily rate-limited. Please try again shortly.";
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes('"code":429') || message.includes("quota")) {
    return "The food parser is temporarily rate-limited. Please try again shortly.";
  }

  return `Error logging food: ${message}`;
}

export class CoachAIService {
  constructor(
    private readonly parser = new FoodLogParser(),
    private readonly resolver = new FoodLogResolver(),
  ) { }

  async logFood(
    username: string,
    foodItemsText: string,
    onProgress?: FoodLogProgressListener,
  ): Promise<FoodLogResult> {
    if (!foodItemsText || foodItemsText.trim().length === 0) {
      return { success: false, message: "No food items provided.", entries: [] };
    }

    const startedAt = performance.now();
    console.log("[Food log] request started.", { username, foodItemsText });

    try {
      //Break the food entry into individual items
      reportProgress(onProgress, 10, "Breaking the food entry into individual items.");
      const parsed = await this.parser.parseIntoFoodEntries(foodItemsText);
      console.log("[Food log] parsed food entries.", { parsed });

      //Find database matches for each item, or create a new food entry if none exists
      const resolved: ResolvedFoodLog[] = [];
      for (const [index, entry] of parsed.entries()) {
        const progress = 40 + ((index / parsed.length) * 35);
        console.log(`\n[Food log] resolving ${entry.food_queries?.[0] || "unknown food"}`);
        let resolvedEntry: ResolvedFoodLog | null = null;
        try {
          resolvedEntry = await this.resolver.resolve(entry, onProgress, progress);
        } catch (error) {
          console.error("[Food log] failed to resolve food entry.", { entry, error });
        }
        if (resolvedEntry) {
          resolved.push(resolvedEntry);
        }
      }

      //   const newFoods = resolved
      //     .filter((entry): entry is NewFoodLog => entry.saveFood)
      //     .map(entry => entry.food);
      //   reportProgress(
      //     onProgress,
      //     78,
      //     newFoods.length
      //       ? `Saving ${newFoods.length} verified food profile${newFoods.length === 1 ? "" : "s"} to the local database.`
      //       : "Every food came from the local database.",
      //   );
      //   logger.info("Persisting newly verified food profiles.", {
      //     newFoodCount: newFoods.length,
      //     newFoods: newFoods.map(food => ({ names: food.names, quantity: food.quantity, sourceId: food.sourceId })),
      //   });
      //   const savedFoods = await FoodDatabase.addFoods(newFoods);

      //   let savedFoodIndex = 0;
      //   const foodsForLogs: FoodItem[] = [];
      //   const results: Array<Omit<FoodLog, "_id" | "logDate">> = resolved.map(entry => {
      //     const food = entry.saveFood ? savedFoods[savedFoodIndex++] : entry.food;
      //     foodsForLogs.push(food);

      //     return {
      //       foodItem_id: food._id,
      //       backup_foodItem: food,
      //       quantity: entry.quantity,
      //       portion: entry.portion,
      //       notes: entry.notes,
      //     };
      //   });

      //   reportProgress(onProgress, 90, `Adding ${results.length} item${results.length === 1 ? "" : "s"} to today's log.`);
      //   logger.info("Saving food-log records to the account.", {
      //     logCount: results.length,
      //     entries: results.map((result, index) => ({
      //       food: getFoodNames(foodsForLogs[index]),
      //       quantity: result.quantity,
      //       portion: result.portion,
      //       notes: result.notes,
      //     })),
      //   });
      //   const savedLogs = await Accounts.addFoodLogs(username, results);
      //   const entries = savedLogs.map((log, index) => {
      //     const food = foodsForLogs[index];
      //     return {
      //       id: log._id!.toHexString(),
      //       loggedAt: log.logDate!.toISOString(),
      //       quantity: log.quantity,
      //       portion: log.portion,
      //       notes: log.notes,
      //       food: {
      //         names: getFoodNames(food),
      //         quantity: food.quantity,
      //         metrics: getFoodMetrics(food),
      //       },
      //     };
      //   });

      //   reportProgress(onProgress, 100, "Food log saved.");
      //   logger.info("Food-log request completed successfully.", {
      //     resultCount: results.length,
      //     elapsedMs: Number((performance.now() - startedAt).toFixed(0)),
      //   });
      // return { success: true, message: `Successfully logged ${results.length} items`, entries };
    } catch (error) {
      console.error("[Food log] request failed.", {
        elapsedMs: Number((performance.now() - startedAt).toFixed(0)),
        error,
      });
      return { success: false, message: userFacingError(error), entries: [] };
    }
  }
}

export const CoachAI = new CoachAIService();
