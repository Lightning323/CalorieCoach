import {
  getUsdaFoodNutrientsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
  UsdaFoodPortion,
} from "../api/usdaFoodDataApi";
import { FoodItem, FoodPortion, getFoodPortions } from "../utils/food-database";
import { keywordSimilarity } from "../utils/utils";
import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";
import { ResolvedFoodLog, readPortionUnit, readPositiveNumber } from "./types";
import { normalizeFoodUnit, resolveUsdaFoodPortion } from "../services/food-portion-service";

interface UsdaFoodRepository {
  getFoodCandidates(query: string, maxResults?: number): Promise<UsdaFood[]>;
  getFoodById(fdcId: number): Promise<UsdaFood>;
}

const MAX_USDA_QUERIES = 3;
const MAX_USDA_CANDIDATES_PER_QUERY = 12;
const MAX_USDA_CANDIDATES = 10;

interface UsdaFoodCandidateResult {
  candidates: UsdaFood[];
  candidateString: string;
}

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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function gramsFromServingSize(food: UsdaFood): number | undefined {
  if (!isPositiveFiniteNumber(food.servingSize)) return undefined;

  const gramsPerUnit: Record<string, number> = {
    mg: 0.001,
    g: 1,
    gram: 1,
    kg: 1_000,
    oz: 28.349523125,
    ounce: 28.349523125,
    lb: 453.59237,
    pound: 453.59237,
  };
  const gramsPerServingUnit = gramsPerUnit[normalizeFoodUnit(food.servingSizeUnit ?? "g")];
  return gramsPerServingUnit ? food.servingSize * gramsPerServingUnit : undefined;
}

function portionUnit(portion: UsdaFoodPortion): string | undefined {
  const measureUnit = portion.measureUnit?.name ?? portion.measureUnit?.abbreviation;
  if (measureUnit && isPositiveFiniteNumber(portion.amount)) {
    return `${portion.amount} ${measureUnit}`;
  }

  return portion.disseminationText
    ?? portion.portionDescription
    ?? portion.modifier
    ?? measureUnit;
}

/** Converts USDA portions into the compact food-database portion shape. */
export function foodPortionsFromUsda(food: UsdaFood): FoodPortion[] {
  const portions: FoodPortion[] = [];
  const measures = food.foodPortions ?? food.foodMeasures ?? [];

  measures.forEach((portion, index) => {
    const unit = portionUnit(portion)?.trim();
    if (!unit || !isPositiveFiniteNumber(portion.gramWeight)) return;

    portions.push({
      unit,
      grams: portion.gramWeight,
      rank: Number.isInteger(portion.rank) && portion.rank! > 0 ? portion.rank! : index + 1,
    });
  });

  if (portions.length === 0) {
    const grams = gramsFromServingSize(food);
    if (grams) portions.push({ unit: "1 serving", grams, rank: 1 });
  }

  // FoodData Central nutrient values are reported per 100 g. Preserve that
  // canonical measure in every stored profile so portion weights can scale it.
  const hasHundredGramPortion = portions.some(portion =>
    portion.grams === 100 && /^100\s*(?:g|grams?)$/i.test(portion.unit),
  );
  if (!hasHundredGramPortion) {
    portions.push({
      unit: "100 grams",
      grams: 100,
      rank: Math.max(0, ...portions.map(portion => portion.rank)) + 1,
    });
  }

  if (portions.length === 1) {
    portions.push({ unit: "1 gram", grams: 1, rank: portions[0].rank + 1 });
  }

  return portions.sort((left, right) => left.rank - right.rank);
}

function unitFromFoodPortion(portion: FoodPortion): { amount: number; unit: string } | undefined {
  const match = portion.unit.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = normalizeFoodUnit(match[2]);
  return isPositiveFiniteNumber(amount) && unit ? { amount, unit } : undefined;
}

function storedFoodPortion(food: FoodItem, rawUnit: string): FoodPortion | undefined {
  const requestedUnit = normalizeFoodUnit(rawUnit);
  return getFoodPortions(food).find(portion => unitFromFoodPortion(portion)?.unit === requestedUnit);
}

export class FoodLogResolver {
  constructor(
    private readonly parser = new FoodLLM(),
    private readonly usdaFoodData: UsdaFoodRepository = UsdaFoodDataApi,
  ) { }

  /**
   * Collect, de-duplicate, and rank USDA results by their best score against
   * any parser-provided alias. The string is suitable for an LLM prompt or
   * diagnostic log and includes the USDA portion-measure metadata.
   */
  private async findUsdaFoodCandidates(
    entries: FoodLogParserEntry[],
  ): Promise<UsdaFoodCandidateResult> {
    const candidates: UsdaFood[] = [];
    const lines: string[] = [];

    for (const entry of entries) {
      const foodsById = new Map<number, UsdaFood>();
      for (const query of candidateQueries(entry)) {
        const results = await this.usdaFoodData.getFoodCandidates(query, MAX_USDA_CANDIDATES_PER_QUERY);
        for (const food of results) {
          if (Number.isSafeInteger(food.fdcId) && food.fdcId > 0 && !foodsById.has(food.fdcId)) {
            foodsById.set(food.fdcId, food);
          }
        }
      }

      const ranked = [...foodsById.values()]
        .map(food => ({
          food,
          similarity: Math.max(...entry.new_food_queries.map(query => keywordSimilarity(query, food.description))),
        }))
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, MAX_USDA_CANDIDATES);

      lines.push(`\nCandidates for "${entry.new_food_queries[0] ?? "unknown food"}":`);
      ranked.forEach(({ food }, index) => {
        candidates.push(food);
        const portions = foodPortionsFromUsda(food).slice(0, 3)
          .map(portion => `${portion.unit} (${portion.grams} grams)`);
        lines.push(`${index + 1}. ${food.description}${portions.length ? `\n   units: ${portions.join(", ")}` : ""}`);
      });
    }

    return { candidates, candidateString: lines.join("\n") };
  }

  /** Converts a USDA food into the app's canonical per-100-g log format. */
  private usdaLog(entry: FoodLogParserEntry, food: UsdaFood, saveFood: boolean): ResolvedFoodLog {
    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const portion = resolveUsdaFoodPortion(food, amount, unit);

    return {
      food: {
        names: [food.description.toLocaleLowerCase(), ...entry.new_food_queries],
        foodNutrients: getUsdaFoodNutrientsPer100g(food),
        foodPortions: foodPortionsFromUsda(food),
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
      return this.usdaLog(entry, await this.usdaFoodData.getFoodById(fdcId), false);
    }

    const amount = readPositiveNumber(entry.quantity);
    const portion = storedFoodPortion(food, readPortionUnit(entry.unit));
    const storedUnit = portion && unitFromFoodPortion(portion);
    if (!portion || !storedUnit) return null;

    return {
      food,
      quantity: amount / storedUnit.amount,
      saveFood: false,
    };
  }

  private async estimateFood(entry: FoodLogParserEntry): Promise<ResolvedFoodLog> {
    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const foodNutrients = await this.parser.guessFoodNutrients(entry);

    return {
      food: {
        names: entry.new_food_queries,
        foodNutrients,
        foodPortions: [
          { unit: `${amount} ${unit}`, grams: 100, rank: 1 },
          { unit: "100 grams", grams: 100, rank: 2 },
        ],
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
      if (entry.database_food) return this.resolveDatabaseFood(entry, entry.database_food);

      const { candidates, candidateString } = await this.findUsdaFoodCandidates([entry]);
      console.log(`\n[Food log] USDA candidates for "${entry.new_food_queries[0] ?? "unknown food"}":\n${candidateString}`);

      const usdaFood = candidates[0];
      return usdaFood
        ? this.usdaLog(entry, await this.usdaFoodData.getFoodById(usdaFood.fdcId), true)
        : this.estimateFood(entry);
    }));
  }
}
