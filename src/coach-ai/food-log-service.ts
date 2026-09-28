import { UsdaFoodDataApiError } from "../api/usdaFoodDataApi";
import { Accounts, FoodLog } from "../utils/account-database";
import { FoodDatabase, FoodItem, getFoodNames, getFoodNutrients, getFoodPortions, getPrimaryFoodPortion } from "../utils/food-database";
import { FoodLLM } from "./food-log-llm";
import { resolveAll, resolveDatabaseMatchPortion } from "./usda-food-resolver";
import { estimateGramsPerUnitFromUsda } from "../services/food-portion-service";
import { parseIntoFoodEntries } from "./database-lookup-splitting";
import {
  FoodLogProgressListener,
  FoodLogResult,
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
  ) { }

  async logFood(
    username: string,
    foodItemsText: string,
    onProgress?: FoodLogProgressListener,
    targetDate?: string,
  ): Promise<FoodLogResult> {
    const startedAt = performance.now();
    try {
      console.log("[Food log] request received.", { foodItemsText, username });
      const resolved = await this.parseFoodLog(foodItemsText, onProgress, true);
      if (resolved.length === 0) {
        throw new Error("No food items could be resolved.");
      }

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
        `Adding ${results.length} item${results.length === 1 ? "" : "s"} to the selected day's log.`,
      );
      console.log("[Food log] Saving food-log records to the account.", {
        logCount: results.length,
        entries: results.map((result, index) => ({
          food: getFoodNames(foodsForLogs[index]),
          quantity: result.quantity,
        })),
      });

      const { date, logs: savedLogs } = await Accounts.addFoodLogs(username, results, targetDate);

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
            foodNutrients: getFoodNutrients(food),
            foodPortions: getFoodPortions(food),
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
        date,
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
        date: null,
        entries: [],
      };
    }
  }

  async parseFoodLog(foodItemsText: string, onProgress?: FoodLogProgressListener, saveNewFoodEntries: boolean = true,): Promise<FoodLog[]> {

    if (!foodItemsText || foodItemsText.trim().length === 0) {
      return [];
    }
    const startedAt = performance.now();

    try {

      reportProgress(onProgress, 10, "Breaking the food entry into individual items.");
      //Create our initial parsed food items, assign database food to our parsed food
      const parsed = await parseIntoFoodEntries(foodItemsText);
      console.log(`[Food log] parsed food entries:\n${JSON.stringify(parsed, null, 2)}`);

      reportProgress(onProgress, 35, "Creating new food entries...");
      await resolveAll(parsed); //Create new USDA food items

      //Convert parsed food entries into foodLogs
      let resolvedEntries: FoodLog[] = [];
      const foodsGainingAPortion = new Set<FoodItem>();

      for (const entry of parsed) {
        if (entry.database_food) {
          const food = entry.database_food;
          const portionCountBefore = food.foodPortions.length;

          // Database matches arrive with an LLM-invented portion shape that
          // display helpers cannot read (rendering as "Serving"). Resolve it
          // to the food's real stored portion so the index shows the correct
          // name (for example, "pancake"), creating the measure the person
          // logged when the food has none (for example, "3 cups" onto a food
          // measured only as "100 g", or "13 m&m's" for "candy"). New foods
          // were already resolved to a real portion by resolveAll, which
          // carries the same measures over.
          let portion = entry.portion;
          if (!entry.saveFood) {
            const resolved = await resolveDatabaseMatchPortion(
              food,
              portion,
              entry.unit,
              // A measure the parser could not weigh is estimated from the
              // food's own USDA record, so the logged count is never applied
              // to an unrelated portion.
              unit => estimateGramsPerUnitFromUsda(food, unit),
            );
            if (resolved) portion = resolved;
          }
          if (!portion) {
            console.log(`WARNING: Food item did not have a portion, using its top portion...`)
            portion = getPrimaryFoodPortion(food) ?? {
              amount: 100,
              measureUnit: {
                name: "gram",
                abbreviation: "g"
              },
              gramWeight: 100,
              rank: 1,
            };
          }
          if (food.foodPortions.length > portionCountBefore) foodsGainingAPortion.add(food);

          resolvedEntries.push({
            food: food,
            quantity: entry.quantity,
            portion: portion,
            saveFood: entry.saveFood ?? false
          });
        }
      }

      reportProgress(onProgress, 75, `Resolved ${parsed.length} food item${parsed.length === 1 ? "" : "s"}.`,);
      console.log(`\n[Food log] resolved food entries:\n${JSON.stringify(resolvedEntries, null, 2)}`);

      if (saveNewFoodEntries) {
        for (const entry of resolvedEntries) {
          if (entry.saveFood && entry.food) {
            console.log(`Adding new food profile to database: ${getFoodNames(entry.food).join(", ")}`);
            entry.food = await FoodDatabase.addFood(entry.food);
          }
        }

        // A measure created for a logged unit is a real change to the stored
        // food, so it is saved to make it selectable the next time round.
        for (const food of foodsGainingAPortion) {
          if (!food._id) continue;

          console.log(`Adding a logged measure to the food profile: ${getFoodNames(food).join(", ")}`);
          await FoodDatabase.updateFood(food._id.toHexString(), { foodPortions: getFoodPortions(food) });
          food.foodPortions = getFoodPortions(food);
        }
      }
      return resolvedEntries;


    } catch (error) {
      console.error("[Food log] request failed.", { elapsedMs: Number((performance.now() - startedAt).toFixed(0)), error, });
      throw error;
    }
  }
}

export const CoachAI = new FoodLoggerAPI();
