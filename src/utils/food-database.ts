import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";
import { match } from "node:assert";

/* ------------------ Types ------------------ */
export interface FoodItem {
  _id?: ObjectId;
  name: string;
  quantity: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

/* ------------------ Food Database Service ------------------ */
export class FoodDatabaseService {
  private collection(): Collection<FoodItem> {
    return getFoodCollection() as unknown as Collection<FoodItem>;
  }

  async addFood(food: Omit<FoodItem, "_id">): Promise<FoodItem> {
    const result = await this.collection().insertOne(food);
    return { _id: result.insertedId, ...food };
  }

  async updateFood(id: string, updates: Partial<Omit<FoodItem, "_id">>) {
    await this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );
  }

  async deleteFood(id: string) {
    await this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  async getFoodByID(id?: ObjectId): Promise<FoodItem | null> {
    if (!id) return null;
    return this.collection().findOne({ _id: new ObjectId(id) });
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
    maxResults = 10
  ): Promise<Array<FoodItem>> {

    const normalize = (s: string) => s.toLowerCase().trim();
    const input = normalize(name);

    // MongoDB query for substring match (case-insensitive)
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const foods = await this.collection()
      .find({ name: { $regex: escapeRegex(input), $options: "i" } })
      .toArray();

    const matches: Array<{ item: FoodItem; confidence: number }> = foods.map(f => ({
      item: f,
      confidence: this.keywordSimilarity(input, normalize(f.name)), // optional scoring
    }));

    // Sort best → worst
    matches.sort((a, b) => b.confidence - a.confidence).slice(0, maxResults);

    // Extract just the FoodItem objects
    var result: FoodItem[] = []
    for (let i = 0; i < matches.length; i++) {
      result.push(matches[i].item)
    }
    return result;
  }



  /* Simple similarity score based on common characters */
  // private similarity(a: string, b: string): number {
  //   if (!a || !b) return 0;
  //   if (a === b) return 1;

  //   let matches = 0;
  //   const minLen = Math.min(a.length, b.length);

  //   for (let i = 0; i < minLen; i++) {
  //     if (a[i] === b[i]) matches++;
  //   }

  //   return matches / Math.max(a.length, b.length);
  // }

  private keywordSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;

    const normalizeWords = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);

    const wordsA = normalizeWords(a);
    const wordsB = normalizeWords(b);

    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    let score = 0;

    for (const wa of wordsA) {
      for (const wb of wordsB) {
        if (wa === wb) {
          // exact word match = strong signal
          score += 1;
        } else if (wa.includes(wb) || wb.includes(wa)) {
          // substring match ("corn" <-> "popcorn")
          const shorter = Math.min(wa.length, wb.length);
          const longer = Math.max(wa.length, wb.length);
          score += shorter / longer; // partial credit
        }
      }
    }

    // Normalize score to 0–1 range
    const maxPossible = Math.max(wordsA.length, wordsB.length);
    return Math.min(score / maxPossible, 1);
  }



}

/* 🔥 Singleton export */
export const FoodDatabase = new FoodDatabaseService();
