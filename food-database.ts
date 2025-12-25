import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "./db";

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
  async getAllFoods(): Promise<FoodItem[]> {
    return this.collection().find().toArray();
  }

  /* Find foods by exact or fuzzy match */
  async findFoodByName(name: string): Promise<{ item: FoodItem; confidence: number } | null> {
    const foods = await this.getAllFoods();

    // Simple fuzzy match using string similarity
    const normalize = (s: string) => s.toLowerCase().trim();

    let bestMatch: FoodItem | null = null;
    let bestScore = 0;

    const input = normalize(name);

    for (const f of foods) {
      const target = normalize(f.name);
      const score = this.similarity(input, target); // 0-1
      if (score > bestScore) {
        bestScore = score;
        bestMatch = f;
      }
    }

    if (bestMatch && bestScore > 0.3) { // adjust threshold if needed
      return { item: bestMatch, confidence: bestScore };
    }

    return null;
  }

  /* Simple similarity score based on common characters */
  private similarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    let matches = 0;
    const minLen = Math.min(a.length, b.length);

    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) matches++;
    }

    return matches / Math.max(a.length, b.length);
  }
}

/* 🔥 Singleton export */
export const Foods = new FoodDatabase();
