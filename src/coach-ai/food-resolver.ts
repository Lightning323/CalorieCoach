import {
  getUsdaMetricsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
} from "../api/usdaFoodDataApi";
import { FoodItem } from "../utils/food-database";
import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";
import { ResolvedFoodLog, readPortionUnit, readPositiveNumber } from "./types";
import { normalizeFoodUnit, resolveUsdaFoodPortion } from "../services/food-portion-service";

interface UsdaFoodRepository {
  getFoodCandidates(query: string, maxResults?: number): Promise<UsdaFood[]>;
  getFoodById(fdcId: number): Promise<UsdaFood>;
}

const MAX_USDA_QUERIES = 3;
const MAX_USDA_CANDIDATES_PER_QUERY = 12;

function candidateQueries(entry: FoodLogParserEntry): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const value of entry.new_food_queries) {
    const query = value.trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;

    seen.add(key);
    queries.push(query);
    if (queries.length === MAX_USDA_QUERIES) break;
  }

  return queries;
}

function fdcIdFromFood(food: FoodItem): number | undefined {
  if (food.source !== "USDA FoodData Central") return undefined;

  const fdcId = Number(food.sourceId);
  return Number.isSafeInteger(fdcId) && fdcId > 0 ? fdcId : undefined;
}

function storedServing(food: FoodItem): { amount: number; unit: string } | undefined {
  const match = food.quantity.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = normalizeFoodUnit(match[2]);
  return Number.isFinite(amount) && amount > 0 && unit ? { amount, unit } : undefined;
}

function isCanonicalUsdaProfile(food: FoodItem): boolean {
  const serving = storedServing(food);
  return fdcIdFromFood(food) !== undefined && serving?.amount === 100 && serving.unit === "g";
}

export class FoodLogResolver {
  constructor(
    private readonly parser = new FoodLLM(),
    private readonly usdaFoodData: UsdaFoodRepository = UsdaFoodDataApi,
  ) {}

  /** Uses aliases in order, so the specific description is searched first. */
  private async findUsdaFood(entry: FoodLogParserEntry): Promise<UsdaFood | null> {
    for (const query of candidateQueries(entry)) {
      const candidates = await this.usdaFoodData.getFoodCandidates(
        query,
        MAX_USDA_CANDIDATES_PER_QUERY,
      );

      const food = candidates.find(candidate =>
        Number.isSafeInteger(candidate.fdcId) && candidate.fdcId > 0,
      );

      if (food) return food;
    }

    return null;
  }

  /** Converts a USDA food into the app's canonical per-100-g log format. */
  private usdaLog(entry: FoodLogParserEntry, food: UsdaFood, saveFood: boolean): ResolvedFoodLog {
    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const portion = resolveUsdaFoodPortion(food, amount, unit);

    return {
      food: {
        names: [food.description.toLocaleLowerCase(), ...entry.new_food_queries],
        quantity: "100 grams",
        metrics: getUsdaMetricsPer100g(food),
        source: "USDA FoodData Central",
        sourceId: String(food.fdcId),
      },
      quantity: portion.grams / 100,
      portion,
      saveFood,
    };
  }

  private async resolveDatabaseFood(
    entry: FoodLogParserEntry,
    food: FoodItem,
  ): Promise<ResolvedFoodLog | null> {
    const fdcId = fdcIdFromFood(food);

    if (fdcId !== undefined) {
      const resolved = this.usdaLog(
        entry,
        await this.usdaFoodData.getFoodById(fdcId),
        !isCanonicalUsdaProfile(food),
      );

      return isCanonicalUsdaProfile(food)
        ? { ...resolved, food, saveFood: false }
        : resolved;
    }

    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const serving = storedServing(food);

    return serving?.unit === unit
      ? { food, quantity: amount / serving.amount, saveFood: false }
      : null;
  }

  private async estimateFood(entry: FoodLogParserEntry): Promise<ResolvedFoodLog> {
    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const metrics = await this.parser.guessNutritionalMetrics(entry);

    return {
      food: {
        names: entry.new_food_queries,
        quantity: `${amount} ${unit}`,
        metrics,
        source: "LLM Estimate",
      },
      quantity: 1,
      saveFood: true,
    };
  }

  /**
   * Resolve database-selected foods directly. Entries without one search USDA,
   * and only fall back to an LLM nutrition estimate when USDA has no result.
   */
  async resolveAll(entries: readonly FoodLogParserEntry[]): Promise<Array<ResolvedFoodLog | null>> {
    return Promise.all(entries.map(async entry => {
      if (entry.database_food) {
        return this.resolveDatabaseFood(entry, entry.database_food);
      }

      const usdaFood = await this.findUsdaFood(entry);
      if (usdaFood) {
        return this.usdaLog(
          entry,
          await this.usdaFoodData.getFoodById(usdaFood.fdcId),
          true,
        );
      }

      return this.estimateFood(entry);
    }));
  }
}
