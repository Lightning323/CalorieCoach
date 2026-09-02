import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";


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

function foodNameKey(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Normalizes aliases while preserving their first-entered display spelling. */
export function normalizeFoodNames(values: readonly unknown[]): string[] {
  const names: string[] = [];
  const knownNames = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_FOOD_NAME_LENGTH) continue;

    const key = foodNameKey(name);
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

export class FoodDatabaseService {
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

  async addFood(food: Omit<FoodItem, "_id">): Promise<FoodItem> {
    const foodForStorage = this.foodForStorage(food);
    const result = await this.collection().insertOne(foodForStorage);
    return { _id: result.insertedId, ...foodForStorage };
  }

  async addFoods(foods: Array<Omit<FoodItem, "_id">>): Promise<FoodItem[]> {
    if (foods.length === 0) return [];

    const foodsForStorage = foods.map(food => this.foodForStorage(food));
    const result = await this.collection().insertMany(foodsForStorage);
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
  }

  async deleteFood(id: string) {
    await this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  async deleteFoods(ids: string[]) {
    if (ids.length === 0) return;
    await this.collection().deleteMany({ _id: { $in: ids.map(id => new ObjectId(id)) } });
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
}

export const FoodDatabase = new FoodDatabaseService();
