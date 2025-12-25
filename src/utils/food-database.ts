import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";

/* ------------------ Types ------------------ */
export interface FoodItem {
  _id?: ObjectId;
  name: string;
  quantity?: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

/* ------------------ Food Database Service ------------------ */
export class FoodDatabase {
  private collection(): Collection<FoodItem> {
    return getFoodCollection() as unknown as Collection<FoodItem>;
  }

  /* Add new food */
  async addFood(food: Omit<FoodItem, "_id">): Promise<FoodItem> {
    const result = await this.collection().insertOne(food);
    return { _id: result.insertedId, ...food };
  }

  /* Update existing food by ID */
  async updateFood(id: string, updates: Partial<Omit<FoodItem, "_id">>) {
    await this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );
  }

  /* Delete food by ID */
  async deleteFood(id: string) {
    await this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  /* Get all foods */
  async getFoodByID(id: string): Promise<FoodItem | null> {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }

  async getAllFoods(): Promise<FoodItem[]> {
    return this.collection().find().toArray();
  }



  async searchFoods(
    name: string,
    minConfidence = 0.01
  ): Promise<Array<{ item: FoodItem; confidence: number }>> {
    console.log("Searching for food:", name);

    const foods = await this.getAllFoods();
    const normalize = (s: string) => s.toLowerCase().trim();
    const input = normalize(name);
    const matches: Array<{ item: FoodItem; confidence: number }> = [];

    for (const f of foods) {
      const target = normalize(f.name);
      const score = this.keywordSimilarity(input, target);
      console.log(
        `Similarity for ${f.name}: ${score}`
      )

      if (score >= minConfidence) {
        matches.push({
          item: f,
          confidence: score,
        });
      }
    }
    // Sort best → worst
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches;
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
export const Foods = new FoodDatabase();
