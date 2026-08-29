import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";
import { keywordSimilarity } from "./utils";

export type FoodMetrics = Record<string, number>;

export interface FoodItem {
  _id?: ObjectId;
  /** Every searchable name for this food. The first name is the display name. */
  names: string[];
  quantity: string;
  /** Nutrient values for one declared serving. */
  metrics?: FoodMetrics;
  /** Legacy fields retained only so existing database records remain readable. */
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  source?: string;
  sourceId?: string;
}

const LEGACY_METRIC_FIELDS = ["calories", "protein", "carbs", "fat"] as const;
const MAX_FOOD_NAMES = 20;
const MAX_FOOD_NAME_LENGTH = 160;

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function searchTokens(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value).split(/[^a-z0-9]+/).filter(token => token.length > 0),
  )];
}

/** Normalizes aliases while preserving their first-entered display spelling. */
export function normalizeFoodNames(values: readonly unknown[]): string[] {
  const names: string[] = [];
  const knownNames = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_FOOD_NAME_LENGTH) continue;

    const key = normalizeSearchText(name);
    if (!knownNames.has(key)) {
      knownNames.add(key);
      names.push(name);
    }
    if (names.length === MAX_FOOD_NAMES) break;
  }

  return names;
}

/** Reads the validated searchable aliases for a food. */
export function getFoodNames(food: Pick<FoodItem, "names"> | null | undefined): string[] {
  if (!food) return [];
  return normalizeFoodNames(Array.isArray(food.names) ? food.names : []);
}

export function getPrimaryFoodName(food: Pick<FoodItem, "names"> | null | undefined): string {
  return getFoodNames(food)[0] ?? "Unnamed food";
}

/** The best alias match is the food's overall name-match score. */
export function getFoodNameMatchScore(query: string, names: readonly string[]): number {
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

export function getFoodMetric(food: FoodItem | null | undefined, metric: string): number {
  if (!food) return 0;

  const value = food.metrics?.[metric];
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (LEGACY_METRIC_FIELDS.includes(metric as typeof LEGACY_METRIC_FIELDS[number])) {
    const legacyValue = food[metric as keyof Pick<FoodItem, "calories" | "protein" | "carbs" | "fat">];
    return typeof legacyValue === "number" && Number.isFinite(legacyValue) ? legacyValue : 0;
  }

  return 0;
}

export function getFoodMetrics(food: FoodItem | null | undefined): FoodMetrics {
  if (!food) return {};

  const metrics: FoodMetrics = { ...food.metrics };
  for (const metric of LEGACY_METRIC_FIELDS) {
    if (metrics[metric] === undefined) metrics[metric] = getFoodMetric(food, metric);
  }

  return metrics;
}

interface FoodSearchCache {
  foods: FoodItem[];
  tokenIndex: Map<string, number[]>;
  loadedAt: number;
}

export class FoodDatabaseService {
  private searchCache?: FoodSearchCache;
  private searchCacheLoad?: { generation: number; promise: Promise<FoodSearchCache> };
  private searchCacheGeneration = 0;
  private readonly searchCacheTtlMs = 60_000;

  private collection(): Collection<FoodItem> {
    return getFoodCollection() as unknown as Collection<FoodItem>;
  }

  private normalizeFood(food: FoodItem): FoodItem {
    return {
      ...food,
      names: getFoodNames(food),
      metrics: getFoodMetrics(food),
    };
  }

  private foodForStorage(food: Omit<FoodItem, "_id">): Omit<FoodItem, "_id"> {
    const { calories, protein, carbs, fat, names, ...foodWithoutLegacyMetrics } = food;
    const normalizedNames = normalizeFoodNames(names);
    if (normalizedNames.length === 0) throw new Error("A food must have at least one name.");

    return {
      ...foodWithoutLegacyMetrics,
      names: normalizedNames,
      metrics: getFoodMetrics(food),
    };
  }

  private clearSearchCache() {
    this.searchCache = undefined;
    this.searchCacheGeneration += 1;
  }

  private createSearchCache(foods: FoodItem[]): FoodSearchCache {
    const normalizedFoods = foods.map(food => this.normalizeFood(food));
    const tokenIndex = new Map<string, number[]>();

    normalizedFoods.forEach((food, index) => {
      for (const token of new Set(getFoodNames(food).flatMap(searchTokens))) {
        const indexes = tokenIndex.get(token) ?? [];
        indexes.push(index);
        tokenIndex.set(token, indexes);
      }
    });

    return { foods: normalizedFoods, tokenIndex, loadedAt: Date.now() };
  }

  private async getSearchCache(): Promise<FoodSearchCache> {
    const now = Date.now();
    if (this.searchCache && now - this.searchCache.loadedAt < this.searchCacheTtlMs) {
      return this.searchCache;
    }

    const generation = this.searchCacheGeneration;
    if (!this.searchCacheLoad || this.searchCacheLoad.generation !== generation) {
      const promise = this.collection().find().toArray()
        .then(foods => this.createSearchCache(foods))
        .then(cache => {
          if (generation === this.searchCacheGeneration) this.searchCache = cache;
          return cache;
        });

      this.searchCacheLoad = { generation, promise };
      promise.then(
        () => {
          if (this.searchCacheLoad?.promise === promise) this.searchCacheLoad = undefined;
        },
        () => {
          if (this.searchCacheLoad?.promise === promise) this.searchCacheLoad = undefined;
        },
      );
    }

    return this.searchCacheLoad.promise;
  }

  async addFood(food: Omit<FoodItem, "_id">): Promise<FoodItem> {
    const foodForStorage = this.foodForStorage(food);
    const result = await this.collection().insertOne(foodForStorage);
    this.clearSearchCache();
    return { _id: result.insertedId, ...foodForStorage };
  }

  async addFoods(foods: Array<Omit<FoodItem, "_id">>): Promise<FoodItem[]> {
    if (foods.length === 0) return [];

    const foodsForStorage = foods.map(food => this.foodForStorage(food));
    const result = await this.collection().insertMany(foodsForStorage);
    this.clearSearchCache();
    return foodsForStorage.map((food, index) => ({
      _id: result.insertedIds[index],
      ...food,
    }));
  }

  async updateFood(id: string, updates: Partial<Omit<FoodItem, "_id">>) {
    const existingFood = await this.collection().findOne({ _id: new ObjectId(id) });
    if (!existingFood) return;

    const {
      calories,
      protein,
      carbs,
      fat,
      names: updatedNames,
      metrics: updatedMetrics,
      ...otherUpdates
    } = updates;
    const names = updatedNames === undefined
      ? getFoodNames(existingFood)
      : normalizeFoodNames(updatedNames);
    if (names.length === 0) throw new Error("A food must have at least one name.");

    const metrics: FoodMetrics = updatedMetrics === undefined
      ? getFoodMetrics(existingFood)
      : { ...updatedMetrics };
    const legacyMetricUpdates = { calories, protein, carbs, fat };
    for (const [metric, value] of Object.entries(legacyMetricUpdates)) {
      if (value !== undefined) metrics[metric] = value;
    }

    await this.collection().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { ...otherUpdates, names, metrics },
        $unset: { calories: "", protein: "", carbs: "", fat: "" },
      },
    );
    this.clearSearchCache();
  }

  async deleteFood(id: string) {
    await this.collection().deleteOne({ _id: new ObjectId(id) });
    this.clearSearchCache();
  }

  async deleteFoods(ids: string[]) {
    if (ids.length === 0) return;
    await this.collection().deleteMany({ _id: { $in: ids.map(id => new ObjectId(id)) } });
    this.clearSearchCache();
  }

  async getFoodByID(id?: ObjectId): Promise<FoodItem | null> {
    if (!id) return null;
    const food = await this.collection().findOne({ _id: new ObjectId(id) });
    return food ? this.normalizeFood(food) : null;
  }

  async getFoodsByIDs(ids: Array<ObjectId | undefined>): Promise<Map<string, FoodItem>> {
    const uniqueIds = [...new Map(
      ids
        .filter((id): id is ObjectId => Boolean(id))
        .map(id => [id.toHexString(), id]),
    ).values()];
    if (uniqueIds.length === 0) return new Map();

    const foods = await this.collection().find({ _id: { $in: uniqueIds } }).toArray();
    return new Map(
      foods
        .filter((food): food is FoodItem & { _id: ObjectId } => Boolean(food._id))
        .map(food => [food._id.toHexString(), this.normalizeFood(food)]),
    );
  }

  async getAllFoods(): Promise<FoodItem[]> {
    return (await this.collection().find().toArray()).map(food => this.normalizeFood(food));
  }

  async getFoodMatches(foodItems: string[], maxResults = 4): Promise<Record<string, FoodItem[]>> {
    const resultsArray = await Promise.all(foodItems.map(item => this.searchFoods(item, maxResults)));
    return Object.fromEntries(foodItems.map((item, index) => [item, resultsArray[index]]));
  }

  async searchFoods(
    name: string,
    maxResults = 10,
    minConfidence = 0,
    printResults = false,
  ): Promise<FoodItem[]> {
    const input = normalizeSearchText(name);
    if (!input) return [];

    const cache = await this.getSearchCache();
    const indexedCandidates = new Set<number>();
    for (const token of searchTokens(input)) {
      for (const index of cache.tokenIndex.get(token) ?? []) indexedCandidates.add(index);
    }
    // Exact alias tokens avoid a full scan in the common case. Fall back to
    // every food only when the search is entirely fuzzy, such as a misspelling.
    const foods = indexedCandidates.size > 0
      ? [...indexedCandidates].map(index => cache.foods[index])
      : cache.foods;
    const matches: Array<{ item: FoodItem; confidence: number }> = [];

    for (const foodItem of foods) {
      const confidence = getFoodNameMatchScore(input, getFoodNames(foodItem));
      if (confidence > minConfidence) matches.push({ item: foodItem, confidence });
    }

    matches.sort((left, right) => right.confidence - left.confidence);
    const topMatches = matches.slice(0, maxResults);
    if (printResults) {
      topMatches.forEach(match => console.log(getPrimaryFoodName(match.item) + ", confidence:", match.confidence));
    }

    return topMatches.map(match => match.item);
  }
}

export const FoodDatabase = new FoodDatabaseService();
