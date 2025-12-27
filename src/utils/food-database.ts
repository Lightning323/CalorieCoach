import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";
import { match } from "node:assert";
import stringSimilarity from "string-similarity";

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
    maxResults = 10,
    minConfidence = 0,
    printResults = false
  ): Promise<Array<FoodItem>> {

    const normalize = (s: string) => s.toLowerCase().trim();
    const input = normalize(name);

    // Get all documents
    const foods = await this.collection().find().toArray();
    var matches: Array<{ item: FoodItem; confidence: number }> = []

    //Add fuzzy matches
    for (const foodItem of foods) {
      const confidence = this.keywordSimilarity(input, normalize(foodItem.name))
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
        // use stringSimilarity for fuzzy comparison
        const similarity = stringSimilarity.compareTwoStrings(wa, wb); // 0–1
        score += similarity; // add the fuzzy score
      }
    }

    // Normalize score to 0–1 range
    const maxPossible = wordsA.length; // using wordsA as the denominator
    return Math.min(score / maxPossible, 1);
  }



}

/* 🔥 Singleton export */
export const FoodDatabase = new FoodDatabaseService();
