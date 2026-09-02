import {
  getUsdaMetricsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
} from "../api/usdaFoodDataApi";
import { FoodItem } from "../utils/food-database";
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

      //Gather the list of food items directly from USDA API
      for (const query of candidateQueries(entry)) {
        const results = await this.usdaFoodData.getFoodCandidates(
          query,
          MAX_USDA_CANDIDATES_PER_QUERY,
        );

        for (const food of results) {
          //Dont include foods that have no fdcId or are already in the map
          // const foodMeasureLength = (food.foodMeasures?.length ?? 0) + (food.foodPortions?.length ?? 0);
          if (Number.isSafeInteger(food.fdcId)
            && food.fdcId > 0
            && !foodsById.has(food.fdcId)
            // && foodMeasureLength
          ) {
            foodsById.set(food.fdcId, food);
          }
        }
      }

      const ranked: Array<{ food: UsdaFood; similarity: number }> = [];

      for (const food of foodsById.values()) {
        let similarity = 0;

        for (const query of entry.new_food_queries) {
          similarity = Math.max(similarity, keywordSimilarity(query, food.description));
        }

        ranked.push({ food, similarity });
      }

      ranked.sort((left, right) => right.similarity - left.similarity);
      const topCandidates = ranked.slice(0, MAX_USDA_CANDIDATES);
      lines.push(`\nCandidates for "${entry.new_food_queries[0] ?? "unknown food"}":`);

      for (let index = 0; index < topCandidates.length; index++) {
        const { food, similarity } = topCandidates[index];
        candidates.push(food);

        const measures = food.foodMeasures ?? food.foodPortions ?? [];
        const measureDetails = new Map<number, string>();

        for (const measure of measures) {
          const text = measure.disseminationText
            ?? measure.portionDescription
            ?? measure.modifier
            ?? measure.measureUnit?.name
            ?? "unspecified";
          const grams = measure.gramWeight ?? "n/a";
          if (measure.rank) {
            if (text.toLowerCase().includes("not specified")
              || text.toLowerCase().includes("unspecified")) {
              measureDetails.set(measure.rank, `${grams} grams`);
            }
            else measureDetails.set(measure.rank, `${text} (${grams} grams)`);
          }
        }
        //sort by rank ascending
        const sortedDetails = new Map([...measureDetails.entries()].sort((a, b) => a[0] - b[0]));
        //Keep only the highest 3
        const measureDetailsLimited = new Map([...sortedDetails.entries()].slice(0, 3));

        if (measureDetailsLimited.size > 0) {
          lines.push(//(similarity: ${similarity.toFixed(2)})
            `${index + 1}. ${food.description}\n`
            + `   units: ${"\n   " + Array.from(measureDetailsLimited.values()).join("\n   ") || "none"}`,
          );
        } else {
          lines.push(//(similarity: ${similarity.toFixed(2)})
            `${index + 1}. ${food.description}`
          );
        }


      }
    }


    return {
      candidates,
      candidateString: lines.join("\n"),
    };
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
    const newEntries = entries.filter(entry => !entry.database_food);
    const { candidates: usdaFoods, candidateString: candidateString } = await this.findUsdaFoodCandidates(newEntries);
    console.log("[Food log] USDA candidates:\n", candidateString, usdaFoods);
  }
}
