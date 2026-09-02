import {
  getUsdaMetricsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
} from "../api/usdaFoodDataApi";
import {
  FoodDatabase,
  FoodItem,
  getFoodNames,
} from "../utils/food-database";
import { keywordSimilarity } from "../utils/utils";
import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";
import { FoodMatchCandidate, selectBatchCandidateIndexes } from "./llm-matching";
import { ResolvedFoodLog, readPortionUnit, readPositiveNumber } from "./types";
import { normalizeFoodUnit, resolveUsdaFoodPortion } from "../services/food-portion-service";

interface FoodRepository {
  getAllFoods(): Promise<FoodItem[]>;
}

interface UsdaFoodRepository {
  getFoodCandidates(query: string, maxResults?: number): Promise<UsdaFood[]>;
  getFoodById(fdcId: number): Promise<UsdaFood>;
}

const MAX_LOCAL_CANDIDATES = 24;
const MAX_USDA_QUERIES = 3;
const MAX_USDA_CANDIDATES_PER_QUERY = 12;
const MAX_USDA_CANDIDATES = 30;

function candidateQueries(entry: FoodLogParserEntry): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const value of entry.food_queries) {
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

/** Names are the only candidate data the matcher needs. */
function databaseCandidate(food: FoodItem): FoodMatchCandidate {
  return { names: getFoodNames(food) };
}

function usdaCandidate(food: UsdaFood): FoodMatchCandidate {
  return {
    names: Array.from(new Set([
      food.description,
      food.brandName,
      food.brandOwner,
      food.additionalDescriptions,
      typeof food.foodCategory === "string" ? food.foodCategory : food.foodCategory?.description,
    ].filter((name): name is string => Boolean(name?.trim())))),
  };
}

/** Keep each batch prompt manageable without changing which foods are matched together. */
function candidateScore(entry: FoodLogParserEntry, candidate: FoodMatchCandidate): number {
  if (candidate.names.length === 0) return 0;
  return Math.max(...entry.food_queries.map(query => Math.max(
    ...candidate.names.map(name => keywordSimilarity(query, name)),
  )), 0);
}

function shortlist<T>(
  entry: FoodLogParserEntry,
  candidates: readonly T[],
  toCandidate: (candidate: T) => FoodMatchCandidate,
  maxCandidates: number,
): T[] {
  return candidates
    .map(candidate => ({ candidate, score: candidateScore(entry, toCandidate(candidate)) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxCandidates)
    .map(({ candidate }) => candidate);
}


export class FoodLogResolver {
  constructor(
    private readonly foodDatabase: FoodRepository = FoodDatabase,
    private readonly parser = new FoodLLM(),
    private readonly usdaFoodData: UsdaFoodRepository = UsdaFoodDataApi,
  ) { }

  /** Read saved foods once, then match every parsed entry in one AI request. */
  private async findLocalMatches(entries: readonly FoodLogParserEntry[]): Promise<Array<FoodItem | null>> {
    const foods = await this.foodDatabase.getAllFoods();
    const canonicalUsdaIds = new Set(
      foods.filter(isCanonicalUsdaProfile)
        .map(fdcIdFromFood)
        .filter((fdcId): fdcId is number => fdcId !== undefined),
    );
    const reusableFoods = foods.filter(food => {
      const fdcId = fdcIdFromFood(food);
      return fdcId === undefined || isCanonicalUsdaProfile(food) || !canonicalUsdaIds.has(fdcId);
    });
    const shortlists = entries.map(entry => shortlist(
      entry,
      reusableFoods,
      databaseCandidate,
      MAX_LOCAL_CANDIDATES,
    ));
    const selections = await selectBatchCandidateIndexes(
      entries,
      shortlists.map(candidates => candidates.map(databaseCandidate)),
    );
    return selections.map((selection, index) =>
      selection === null ? null : shortlists[index][selection] ?? null,
    );
  }

  private async getUsdaCandidates(entry: FoodLogParserEntry): Promise<UsdaFood[]> {
    const searches = await Promise.all(candidateQueries(entry).map(query =>
      this.usdaFoodData.getFoodCandidates(query, MAX_USDA_CANDIDATES_PER_QUERY),
    ));
    const candidates = new Map<number, UsdaFood>();
    for (const search of searches) {
      for (const food of search) {
        if (!candidates.has(food.fdcId)) candidates.set(food.fdcId, food);
        if (candidates.size === MAX_USDA_CANDIDATES) return [...candidates.values()];
      }
    }
    return [...candidates.values()];
  }

  /** Fetch USDA candidate groups concurrently, then match them in one AI request. */
  private async findUsdaMatches(entries: readonly FoodLogParserEntry[]): Promise<Array<UsdaFood | null>> {
    const candidateGroups = await Promise.all(entries.map(entry => this.getUsdaCandidates(entry)));
    const shortlists = entries.map((entry, index) => shortlist(
      entry,
      candidateGroups[index],
      usdaCandidate,
      MAX_USDA_CANDIDATES,
    ));
    const selections = await selectBatchCandidateIndexes(
      entries,
      shortlists.map(candidates => candidates.map(usdaCandidate)),
    );
    return selections.map((selection, index) =>
      selection === null ? null : shortlists[index][selection] ?? null,
    );
  }

  /** Convert a USDA food into the app's canonical per-100-g log format. */
  private usdaLog(entry: FoodLogParserEntry, food: UsdaFood, saveFood: boolean): ResolvedFoodLog {
    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const portion = resolveUsdaFoodPortion(food, amount, unit);

    return {
      food: {
        names: [food.description.toLocaleLowerCase(), entry.food_queries[0] ?? ""],
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

  /** Re-check saved USDA foods so a new count can be converted to grams. */
  private async resolveSavedFood(entry: FoodLogParserEntry, food: FoodItem): Promise<ResolvedFoodLog | null> {
    const fdcId = fdcIdFromFood(food);
    if (fdcId !== undefined) {
      try {
        const resolved = this.usdaLog(entry, await this.usdaFoodData.getFoodById(fdcId), !isCanonicalUsdaProfile(food));
        return isCanonicalUsdaProfile(food) ? { ...resolved, food, saveFood: false } : resolved;
      } catch {
        return null;
      }
    }

    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const serving = storedServing(food);
    return serving?.unit === unit
      ? { food, quantity: amount / serving.amount, saveFood: false }
      : null;
  }

  private async resolveUsdaMatch(entry: FoodLogParserEntry, food: UsdaFood | null): Promise<ResolvedFoodLog | null> {
    if (!food || !Number.isSafeInteger(food.fdcId) || food.fdcId <= 0) return null;
    return this.usdaLog(entry, await this.usdaFoodData.getFoodById(food.fdcId), true);
  }

  private async estimateFood(entry: FoodLogParserEntry): Promise<ResolvedFoodLog> {
    const amount = readPositiveNumber(entry.quantity);
    const unit = normalizeFoodUnit(readPortionUnit(entry.unit));
    const metrics = await this.parser.guessNutritionalMetrics(entry);
    return {
      food: {
        names: entry.food_queries,
        // An LLM estimate describes the whole entered portion, so log it once.
        quantity: `${amount} ${unit}`,
        metrics,
        source: "LLM Estimate",
      },
      quantity: 1,
      saveFood: true,
    };
  }

  /**
   * Resolves a parsed meal in three stages: one local batch match, one USDA
   * batch match for the unresolved foods, then estimates only as a final fallback.
   */
  async resolveAll(entries: readonly FoodLogParserEntry[]): Promise<Array<ResolvedFoodLog | null>> {
    if (entries.length === 0) return [];

    const selectedLocalFoods = await this.findLocalMatches(entries);
    const resolved = await Promise.all(entries.map((entry, index) => {
      const localFood = selectedLocalFoods[index];
      return localFood ? this.resolveSavedFood(entry, localFood) : null;
    }));

    const unresolvedIndexes = resolved
      .map((result, index) => result === null ? index : -1)
      .filter((index): index is number => index >= 0);
    if (unresolvedIndexes.length === 0) return resolved;

    const unresolvedEntries = unresolvedIndexes.map(index => entries[index]);
    const selectedUsdaFoods = await this.findUsdaMatches(unresolvedEntries);
    const usdaResolved = await Promise.all(unresolvedEntries.map((entry, index) =>
      this.resolveUsdaMatch(entry, selectedUsdaFoods[index]),
    ));

    await Promise.all(unresolvedIndexes.map(async (originalIndex, index) => {
      resolved[originalIndex] = usdaResolved[index] ?? await this.estimateFood(entries[originalIndex]);
    }));
    return resolved;
  }

  /** Backwards-compatible single-item entry point. */
  async resolve(entry: FoodLogParserEntry): Promise<ResolvedFoodLog | null> {
    return (await this.resolveAll([entry]))[0] ?? null;
  }
}
