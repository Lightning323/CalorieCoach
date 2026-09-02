import { UsdaFoodDataApiError } from "../api/usdaFoodDataApi";
import { Accounts, FoodLog } from "../utils/account-database";
import { FoodDatabase, FoodItem, getFoodMetrics, getFoodNames } from "../utils/food-database";
import { FoodLLM } from "./food-log-llm";
import { FoodLogResolver } from "./food-resolver";
import {
  FoodLogProgressListener,
  FoodLogResult,
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

export class FoodLoggerAPI {
  constructor(
    private readonly parser = new FoodLLM(),
    private readonly resolver = new FoodLogResolver(),
  ) { }

  async logFood(
      username: string,
      foodItemsText: string,
      onProgress?: FoodLogProgressListener, 
  ): Promise<FoodLogResult> {
    const startedAt = performance.now();
    try {
      console.log("[Food log] request received.", { foodItemsText, username });
      const resolved = await this.parseFoodLog(foodItemsText, onProgress, true);

      // Build food logs for database storage
      const foodsForLogs: FoodItem[] = [];
      const results: Array<Omit<FoodLog, "_id" | "logDate">> = resolved.map((entry) => {
        const food = entry.food as FoodItem;
        foodsForLogs.push(food);

        return {
          foodItem_id: food._id,
          backup_foodItem: food,
          quantity: entry.quantity,
          portion: entry.portion,
          notes: "",
        };
      });

      // Save food logs to account
      reportProgress(
        onProgress,
        90,
        `Adding ${results.length} item${results.length === 1 ? "" : "s"} to today's log.`,
      );
      console.log("[Food log] Saving food-log records to the account.", {
        logCount: results.length,
        entries: results.map((result, index) => ({
          food: getFoodNames(foodsForLogs[index]),
          quantity: result.quantity,
        })),
      });

      const savedLogs = await Accounts.addFoodLogs(username, results);

      // Format response entries
      const entries = savedLogs.map((log, index) => {
        const food = foodsForLogs[index];
        return {
          id: log._id!.toHexString(),
          loggedAt: log.logDate!.toISOString(),
          quantity: log.quantity,
          portion: log.portion,
          notes: "",
          food: {
            names: getFoodNames(food),
            quantity: food.quantity,
            metrics: getFoodMetrics(food),
          },
        };
      });

      reportProgress(onProgress, 100, "Food log saved.");
      console.log("[Food log] Food-log request completed successfully.", {
        resultCount: results.length,
        elapsedMs: Number((performance.now() - startedAt).toFixed(0)),
      });

      return {
        success: true,
        message: `Successfully logged ${results.length} item${results.length === 1 ? "" : "s"}`,
        entries,
      };
    } catch (error) {
      const message = userFacingError(error);
      console.error("[Food log] request failed.", {
        elapsedMs: Number((performance.now() - startedAt).toFixed(0)),
        error,
      });
      return {
        success: false,
        message,
        entries: [],
      };
    }
  }

  async parseFoodLog(
    foodItemsText: string,
    onProgress?: FoodLogProgressListener,
    saveNewFoodEntries: boolean   = true,
  ): Promise<ResolvedFoodLog[]> {
    if (!foodItemsText || foodItemsText.trim().length === 0) {
      return [];
    }
    const startedAt = performance.now();
    try {
      //Break the food entry into individual items
      reportProgress(onProgress, 10, "Breaking the food entry into individual items.");
      const parsed = await this.parser.parseIntoFoodEntries(foodItemsText);
      console.log(`[Food log] parsed food entries:\n${JSON.stringify(parsed, null, 2)}`);

      // Resolve independent entries concurrently. This overlaps the database and
      // USDA network requests while Promise.all preserves the parsed input order.
      let completedCount = 0;
      const resolvedEntries = await Promise.all(parsed.map(async (entry) => {
        console.log(`\n[Food log] resolving ${entry.food_queries?.[0] || "unknown food"}`);
        try {
          return await this.resolver.resolve(entry);
        } catch (error) {
          console.error("[Food log] failed to resolve food entry.", { entry, error });
          return null;
        } finally {
          completedCount += 1;
          reportProgress(
            onProgress,
            40 + ((completedCount / parsed.length) * 35),
            `Resolved ${completedCount} of ${parsed.length} food item${parsed.length === 1 ? "" : "s"}.`,
          );
        }
      }));
      const resolved = resolvedEntries.filter((entry): entry is ResolvedFoodLog => entry !== null);
      console.log(`\n[Food log] resolved food entries:\n${JSON.stringify(resolved, null, 2)}`);
      if (saveNewFoodEntries) {
        for (const entry of resolved) {
          if (entry.saveFood) {
            console.log(`Adding new food profile to database: ${getFoodNames(entry.food).join(", ")}`);
            entry.food = await FoodDatabase.addFood(entry.food);
          }
        }
      }
      return resolved;

    } catch (error) {
      console.error("[Food log] request failed.", {
        elapsedMs: Number((performance.now() - startedAt).toFixed(0)),
        error,
      });
      return [];
    }
  }
}

export const CoachAI = new FoodLoggerAPI();
