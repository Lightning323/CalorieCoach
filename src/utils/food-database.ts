import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";
import { keywordSimilarity } from "./utils";

/* ------------------ Types ------------------ */
export interface FoodItem {
  _id?: ObjectId;
  name: string;
  quantity: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  source?: string;
  sourceId?: string;
}

/* ------------------ Food Database Service ------------------ */
export class FoodDatabaseService {
  private searchCache?: { foods: FoodItem[]; loadedAt: number };
  private searchCacheLoad?: { generation: number; promise: Promise<FoodItem[]> };
  private searchCacheGeneration = 0;
  private readonly searchCacheTtlMs = 60_000;

  private collection(): Collection<FoodItem> {
    return getFoodCollection() as unknown as Collection<FoodItem>;
  }

  private clearSearchCache() {
    this.searchCache = undefined;
    this.searchCacheGeneration += 1;
  }

  private async getSearchableFoods(): Promise<FoodItem[]> {
    const now = Date.now();
    if (this.searchCache && now - this.searchCache.loadedAt < this.searchCacheTtlMs) {
      return this.searchCache.foods;
    }

    const generation = this.searchCacheGeneration;
    if (!this.searchCacheLoad || this.searchCacheLoad.generation !== generation) {
      const promise = this.collection().find().toArray()
        .then(foods => {
          if (generation === this.searchCacheGeneration) {
            this.searchCache = { foods, loadedAt: Date.now() };
          }
          return foods;
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
    const result = await this.collection().insertOne(food);
    this.clearSearchCache();
    return { _id: result.insertedId, ...food };
  }

  async addFoods(foods: Array<Omit<FoodItem, "_id">>): Promise<FoodItem[]> {
    if (foods.length === 0) return [];

    const result = await this.collection().insertMany(foods);
    this.clearSearchCache();
    return foods.map((food, index) => ({
      _id: result.insertedIds[index],
      ...food,
    }));
  }

  async updateFood(id: string, updates: Partial<Omit<FoodItem, "_id">>) {
    await this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );
    this.clearSearchCache();
  }

  async deleteFood(id: string) {
    await this.collection().deleteOne({ _id: new ObjectId(id) });
    this.clearSearchCache();
  }

  async getFoodByID(id?: ObjectId): Promise<FoodItem | null> {
    if (!id) return null;
    return this.collection().findOne({ _id: new ObjectId(id) });
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
        .map(food => [food._id.toHexString(), food]),
    );
  }

  async getAllFoods(): Promise<FoodItem[]> {
    return this.collection().find().toArray();
  }

  async getFoodMatches(
    foodItems: string[],
    maxResults = 4
  ): Promise<Record<string, FoodItem[]>> {
    // Map each query to a promise
    const queries = foodItems.map(async (item) => {
      const matches = await this.searchFoods(item, maxResults);
      // Extract only the FoodItem objects, ignoring confidence
      return matches.map(m => m);
    });

    // Run all searches in parallel
    const resultsArray = await Promise.all(queries);

    // Build map from original food item to array of matches
    const resultMap: Record<string, FoodItem[]> = {};
    foodItems.forEach((item, index) => {
      resultMap[item] = resultsArray[index];
    });

    return resultMap;
  }


  async searchFoods(
    name: string,
    maxResults = 10,
    minConfidence = 0,
    printResults = false
  ): Promise<Array<FoodItem>> {

    const normalize = (s: string) => s.toLowerCase().trim();
    const input = normalize(name);

    const foods = await this.getSearchableFoods();
    var matches: Array<{ item: FoodItem; confidence: number }> = []

    //Add fuzzy matches
    for (const foodItem of foods) {
      const confidence = keywordSimilarity(input, normalize(foodItem.name))
      if (confidence > minConfidence) {
        matches.push({
          item: foodItem,
          confidence: confidence
        })
      }
    }

    // Sort by confidence descending
    matches.sort((a, b) => b.confidence - a.confidence);

    // Take top maxResults
    const topMatches = matches.slice(0, maxResults);

    //Print results
    if (printResults) {
      for (let i = 0; i < topMatches.length; i++) {
        console.log(topMatches[i].item.name + ", confidence:", topMatches[i].confidence);
      }
    }

    // Extract just FoodItem objects
    return topMatches.map(m => m.item);
  }

  



}

/* 🔥 Singleton export */
export const FoodDatabase = new FoodDatabaseService();
