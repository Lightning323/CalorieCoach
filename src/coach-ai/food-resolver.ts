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
import {
  FoodLLM,
  FoodLogParserEntry,
  FoodMatchCandidate,
} from "./food-log-llm";
import {
  FoodLogProgressListener,
  ResolvedFoodLog,
  readPortionUnit,
  readPositiveNumber,
  reportProgress,
} from "./types";
import { normalizeFoodUnit, resolveUsdaFoodPortion } from "../services/food-portion-service";

interface FoodRepository {
  getAllFoods(): Promise<FoodItem[]>;
}

interface UsdaFoodRepository {
  getFoodCandidates(query: string, maxResults?: number): Promise<UsdaFood[]>;
  getFoodById(fdcId: number): Promise<UsdaFood>;
}

const MAX_LOCAL_LLM_CANDIDATES = 24;
const MAX_USDA_QUERIES = 3;
const MAX_USDA_CANDIDATES_PER_QUERY = 12;
const MAX_USDA_LLM_CANDIDATES = 30;

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function searchTokens(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value).split(/[^a-z0-9]+/).filter(Boolean),
  )];
}

/**
 * String comparison only keeps the candidate prompt compact. FoodLLM, never
 * this score, decides whether a candidate is an acceptable match.
 */
function shortlistScore(query: string, names: readonly string[]): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || names.length === 0) return 0;

  const queryTokens = searchTokens(normalizedQuery);
  return Math.max(...names.map(name => {
    const normalizedName = normalizeSearchText(name);
    const similarity = keywordSimilarity(normalizedQuery, normalizedName);
    const nameTokens = new Set(searchTokens(normalizedName));
    const tokenCoverage = queryTokens.length === 0
      ? 0
      : queryTokens.filter(token => nameTokens.has(token)).length / queryTokens.length;
    return Math.min(1, similarity + (tokenCoverage * 0.25));
  }));
}

function candidateQueries(entry: FoodLogParserEntry): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];

  for (const value of entry.food_queries) {
    const query = value.trim();
    const key = query.toLocaleLowerCase();
    if (!query || seen.has(key)) continue;

    seen.add(key);
    queries.push(query);
    if (queries.length === MAX_USDA_QUERIES) break;
  }

  return queries;
}

function foodCategoryText(food: UsdaFood): string | undefined {
  const category = food.foodCategory;
  if (typeof category === "string") return category;
  return category?.description;
}

function compactText(value: string | undefined, maxLength = 240): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function detail(label: string, value: string | undefined): string | undefined {
  const text = compactText(value);
  return text ? `${label}: ${text}` : undefined;
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
  return fdcIdFromFood(food) !== undefined
    && serving?.amount === 100
    && serving.unit === "g";
}

export class FoodLogResolver {
  constructor(
    private readonly foodDatabase: FoodRepository = FoodDatabase,
    private readonly parser = new FoodLLM(),
    private readonly usdaFoodData: UsdaFoodRepository = UsdaFoodDataApi,
  ) { }

  private async chooseCandidate<T>(
    entry: FoodLogParserEntry,
    candidates: readonly T[],
    toFoodMatchCandidate: (candidate: T) => FoodMatchCandidate,
  ): Promise<T | null> {
    if (candidates.length === 0) return null;
    //Candidates cant be more than 25 elements
    if (candidates.length > 25) {
      candidates = candidates.slice(0, 25);
    }

    try {
      const candidateIndex = await this.parser.selectBestFoodCandidate(
        entry,
        candidates.map(toFoodMatchCandidate)
      );
      if (candidateIndex === null) {
        return null;
      }

      return candidates[candidateIndex] ?? null;
    } catch (error) {
      return null;
    }
  }

  async findLocalMatch(entry: FoodLogParserEntry): Promise<FoodItem | null> {
    const foods = await this.foodDatabase.getAllFoods();
    // A legacy USDA cache may describe one serving while a newer profile for
    // the same FDC item stores the canonical per-100-g metrics. Do not offer
    // the legacy duplicate once the safe representation exists.
    const canonicalUsdaIds = new Set(
      foods.filter(isCanonicalUsdaProfile)
        .map(fdcIdFromFood)
        .filter((fdcId): fdcId is number => fdcId !== undefined),
    );
    const reusableFoods = foods.filter(food => {
      const fdcId = fdcIdFromFood(food);
      return fdcId === undefined || isCanonicalUsdaProfile(food) || !canonicalUsdaIds.has(fdcId);
    });
    const rankedCandidates = reusableFoods
      .map(food => ({
        food,
        score: Math.max(...entry.food_queries.map(query => shortlistScore(query, getFoodNames(food))), 0),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_LOCAL_LLM_CANDIDATES)
      .map(({ food }) => food);

    console.log(`[Food log] offering ${rankedCandidates.length} saved food candidate(s) to the LLM.`);
    return this.chooseCandidate(
      entry,
      rankedCandidates,
      food => ({
        name: getFoodNames(food)[0] ?? "Unnamed food",
        aliases: getFoodNames(food),
        details: [
          `Serving: ${food.quantity}`,
          detail("Source", food.source),
        ].filter((detail): detail is string => Boolean(detail)),
      }),
    );
  }

  async findUsdaMatch(entry: FoodLogParserEntry): Promise<UsdaFood | null> {
    const queries = candidateQueries(entry);
    if (queries.length === 0) return null;

    const candidateGroups = await Promise.all(queries.map(query =>
      this.usdaFoodData.getFoodCandidates(query, MAX_USDA_CANDIDATES_PER_QUERY),
    ));
    const candidatesById = new Map<number, UsdaFood>();
    for (const candidateGroup of candidateGroups) {
      for (const candidate of candidateGroup) {
        if (!candidatesById.has(candidate.fdcId)) candidatesById.set(candidate.fdcId, candidate);
        if (candidatesById.size === MAX_USDA_LLM_CANDIDATES) break;
      }
      if (candidatesById.size === MAX_USDA_LLM_CANDIDATES) break;
    }
    const candidates = [...candidatesById.values()];

    console.log(`[Food log] offering ${candidates.length} USDA candidate(s) to the LLM.`);
    const selectedCandidate = await this.chooseCandidate(
      entry,
      candidates,
      food => ({
        name: food.description,
        details: [
          detail("Brand", food.brandName),
          detail("Brand owner", food.brandOwner),
          detail("Category", foodCategoryText(food)),
          detail("Serving", food.householdServingFullText),
          detail("Ingredients", food.ingredients),
        ].filter((detail): detail is string => Boolean(detail)),
      }),
    );

    if (!selectedCandidate || !Number.isSafeInteger(selectedCandidate.fdcId) || selectedCandidate.fdcId <= 0) {
      return null;
    }
    return this.usdaFoodData.getFoodById(selectedCandidate.fdcId);
  }

  private resolvedUsdaFood(
    entry: FoodLogParserEntry,
    amount: number,
    unit: string,
    verifiedFood: UsdaFood,
    saveFood: boolean,
  ): ResolvedFoodLog {
    const portion = resolveUsdaFoodPortion(verifiedFood, amount, unit);
    const metricsPer100g = getUsdaMetricsPer100g(verifiedFood);

    console.debug("[Food portion] resolved USDA portion.", {
      food: verifiedFood.description,
      input: `${portion.amount} ${portion.unit}`,
      usdaServing: {
        household: verifiedFood.householdServingFullText,
        servingSize: verifiedFood.servingSize,
        servingSizeUnit: verifiedFood.servingSizeUnit,
      },
      grams: portion.grams,
      source: portion.source,
    });

    return {
      food: {
        names: [verifiedFood.description.toLocaleLowerCase(), entry.food_queries[0] ?? ""],
        // USDA foodNutrients are per 100 g. Storing them unchanged makes the
        // log multiplier grams / 100 and prevents serving-size double scaling.
        quantity: "100 grams",
        metrics: metricsPer100g,
        source: "USDA FoodData Central",
        sourceId: String(verifiedFood.fdcId),
      },
      quantity: portion.grams / 100,
      portion,
      saveFood,
    };
  }

  private async resolveSavedFood(
    localMatch: FoodItem,
    amount: number,
    unit: string,
  ): Promise<ResolvedFoodLog | null> {
    const fdcId = fdcIdFromFood(localMatch);
    if (fdcId !== undefined) {
      // A saved USDA profile identifies the food, but its old cached serving
      // cannot safely interpret a new count such as "20 chips". Re-read its
      // USDA portion metadata and resolve the new requested unit from grams.
      let verifiedFood: UsdaFood;
      try {
        verifiedFood = await this.usdaFoodData.getFoodById(fdcId);
      } catch (error) {
        console.warn("[Food log] could not refresh a saved USDA food; searching candidates instead.", {
          fdcId,
          error,
        });
        return null;
      }
      const resolved = this.resolvedUsdaFood(
        {
          food_queries: getFoodNames(localMatch),
          quantity: amount,
          unit,
        },
        amount,
        unit,
        verifiedFood,
        !isCanonicalUsdaProfile(localMatch),
      );
      // Canonical profiles already store USDA nutrients per 100 g, so retain
      // their id for the log. Legacy profiles are replaced with a new
      // canonical record and are excluded from future candidate lists.
      return isCanonicalUsdaProfile(localMatch)
        ? { ...resolved, food: localMatch, saveFood: false }
        : resolved;
    }

    const serving = storedServing(localMatch);
    if (serving?.unit !== unit) return null;

    // User-created profiles keep their declared serving convention. They are
    // only reused when the requested unit is exactly the saved unit, so a
    // count is never silently treated as a number of servings.
    return {
      food: localMatch,
      quantity: amount / serving.amount,
      saveFood: false,
    };
  }

  async resolve(
    entry: FoodLogParserEntry,
    onProgress?: FoodLogProgressListener,
    progress = 55,
    verbose = false,
  ): Promise<ResolvedFoodLog | null> {
    const amount = readPositiveNumber(entry.quantity);
    const unit = readPortionUnit(entry.unit);
    const normalizedUnit = normalizeFoodUnit(unit);

    reportProgress(onProgress, progress, "Checking saved foods.");
    const localMatch = await this.findLocalMatch(entry);
    if (localMatch) {
      const resolvedLocalFood = await this.resolveSavedFood(localMatch, amount, normalizedUnit);
      if (resolvedLocalFood) {
        if (verbose) console.log("[Food log] using LLM-selected saved food.", { names: localMatch.names });
        return resolvedLocalFood;
      }
    }

    reportProgress(onProgress, progress + 3, "Looking up USDA FoodData Central.");
    const verifiedFood = await this.findUsdaMatch(entry);
    if (verifiedFood) {
      if (verbose) console.log("[Food log] using LLM-selected USDA food.", { usdaFood: verifiedFood });
      return this.resolvedUsdaFood(entry, amount, normalizedUnit, verifiedFood, true);
    }

    if (verbose) console.log("[Food log] no saved or USDA candidate selected.");
    const metrics = await this.parser.guessNutritionalMetrics(entry);
    return {
      food: {
        names: entry.food_queries,
        // LLM estimates describe the complete requested portion, unlike USDA
        // nutrients which are per 100 g. Store one estimate and log it once.
        quantity: `${amount} ${normalizedUnit}`,
        metrics,
        source: "LLM Estimate",
      },
      quantity: 1,
      saveFood: true,
    };
  }
}
