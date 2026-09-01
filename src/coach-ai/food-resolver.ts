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
  scaleFoodMetricsPer100g,
} from "./types";

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

export class FoodLogResolver {
  constructor(
    private readonly foodDatabase: FoodRepository = FoodDatabase,
    private readonly parser = new FoodLLM(),
    private readonly usdaFoodData: UsdaFoodRepository = UsdaFoodDataApi,
  ) { }

  private async chooseCandidate<T>(
    entry: FoodLogParserEntry,
    candidates: readonly T[],
    source: string,
    toFoodMatchCandidate: (candidate: T) => FoodMatchCandidate,
  ): Promise<T | null> {
    if (candidates.length === 0) return null;

    try {
      const candidateIndex = await this.parser.selectBestFoodCandidate(
        entry,
        candidates.map(toFoodMatchCandidate),
        source,
      );
      if (candidateIndex === null) {
        console.log(`[Food log] LLM declined all ${candidates.length} ${source} candidate(s).`);
        return null;
      }

      return candidates[candidateIndex] ?? null;
    } catch (error) {
      console.error(`[Food log] LLM could not select a ${source} candidate.`, { error });
      return null;
    }
  }

  async findLocalMatch(entry: FoodLogParserEntry): Promise<FoodItem | null> {
    const foods = await this.foodDatabase.getAllFoods();
    const rankedCandidates = foods
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
      "saved food profiles",
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
      "USDA FoodData Central",
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

    return selectedCandidate
      ? this.usdaFoodData.getFoodById(selectedCandidate.fdcId)
      : null;
  }

  async resolve(
    entry: FoodLogParserEntry,
    onProgress?: FoodLogProgressListener,
    progress = 55,
    verbose = false,
  ): Promise<ResolvedFoodLog | null> {
    const amount = readPositiveNumber(entry.quantity);
    const unit = readPortionUnit(entry.unit);
    const grams = readPositiveNumber(entry.grams);

    reportProgress(onProgress, progress, "Checking saved foods.");
    const localMatch = await this.findLocalMatch(entry);
    if (localMatch) {
      if (verbose) console.log("[Food log] using LLM-selected saved food.", { names: localMatch.names });
      return {
        food: localMatch,
        quantity: amount,
        saveFood: false,
      };
    }

    reportProgress(onProgress, progress + 3, "Looking up USDA FoodData Central.");
    const verifiedFood = await this.findUsdaMatch(entry);
    if (verifiedFood) {
      const metrics = scaleFoodMetricsPer100g(getUsdaMetricsPer100g(verifiedFood), grams);
      if (verbose) console.log("[Food log] using LLM-selected USDA food.", { usdaFood: verifiedFood });

      return {
        food: {
          names: [verifiedFood.description.toLocaleLowerCase(), entry.food_queries[0] ?? ""],
          quantity: `1 ${unit}`,
          metrics,
          source: "USDA FoodData Central",
          sourceId: String(verifiedFood.fdcId),
        },
        quantity: amount,
        saveFood: true,
      };
    }

    if (verbose) console.log("[Food log] no saved or USDA candidate selected.");
    const metrics = await this.parser.guessNutritionalMetrics(entry);
    return {
      food: {
        names: entry.food_queries,
        quantity: `1 ${unit}`,
        metrics,
        source: "LLM Estimate",
      },
      quantity: amount,
      saveFood: true,
    };
  }
}
