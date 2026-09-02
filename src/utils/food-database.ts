import { ObjectId, Collection } from "mongodb";
import { getFoodCollection } from "../db";

export type FoodNutrients = Record<string, number>;

/**
 * A food-specific measure. `unit` is the complete, human-readable measure
 * (for example, "1 slice" or "1 cup"); `grams` is its edible weight.
 * `rank` preserves the order supplied by FoodData Central.
 */
export interface FoodPortion {
  unit: string;
  grams: number;
  rank: number;
}

export interface FoodItem {
  _id?: ObjectId;
  /** Every searchable name for this food. The first name is the display name. */
  names: string[];
  /** Nutrition for the food's canonical serving. */
  foodNutrients: FoodNutrients;
  /** FoodData Central-style measures for this food, ordered by rank. */
  foodPortions: FoodPortion[];
  source?: string;
  sourceId?: string;
}

const MAX_FOOD_NAMES = 20;
const MAX_FOOD_NAME_LENGTH = 160;
const MAX_FOOD_PORTION_UNIT_LENGTH = 160;

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

export function normalizeFoodNutrients(value: unknown): FoodNutrients {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(([, nutrient]) =>
      typeof nutrient === "number" && Number.isFinite(nutrient),
    ),
  );
}

export function getFoodNutrients(food: Pick<FoodItem, "foodNutrients"> | null | undefined): FoodNutrients {
  return normalizeFoodNutrients(food?.foodNutrients);
}

export function normalizeFoodPortions(value: unknown): FoodPortion[] {
  if (!Array.isArray(value)) return [];

  const portions: FoodPortion[] = [];
  for (const portion of value) {
    if (!portion || typeof portion !== "object" || Array.isArray(portion)) continue;

    const { unit, grams, rank } = portion as Record<string, unknown>;
    const normalizedUnit = typeof unit === "string" ? unit.trim().replace(/\s+/g, " ") : "";
    if (
      !normalizedUnit ||
      normalizedUnit.length > MAX_FOOD_PORTION_UNIT_LENGTH ||
      typeof grams !== "number" ||
      !Number.isFinite(grams) ||
      grams <= 0 ||
      typeof rank !== "number" ||
      !Number.isInteger(rank) ||
      rank <= 0
    ) {
      continue;
    }

    portions.push({ unit: normalizedUnit, grams, rank });
  }

  return portions.sort((left, right) => left.rank - right.rank);
}

export function getFoodPortions(food: Pick<FoodItem, "foodPortions"> | null | undefined): FoodPortion[] {
  return normalizeFoodPortions(food?.foodPortions);
}

export function getPrimaryFoodPortion(food: Pick<FoodItem, "foodPortions"> | null | undefined): FoodPortion | null {
  return getFoodPortions(food)[0] ?? null;
}

export function getFoodServingDescription(food: Pick<FoodItem, "foodPortions"> | null | undefined): string {
  return getPrimaryFoodPortion(food)?.unit ?? "Serving not specified";
}

export class FoodDatabaseService {
  private collection(): Collection<FoodItem> {
    return getFoodCollection() as unknown as Collection<FoodItem>;
  }

  private normalizeFood(food: FoodItem): FoodItem {
    return {
      ...food,
      names: getFoodNames(food),
      foodNutrients: getFoodNutrients(food),
      foodPortions: getFoodPortions(food),
    };
  }

  private foodForStorage(food: Omit<FoodItem, "_id">): Omit<FoodItem, "_id"> {
    const names = normalizeFoodNames(food.names);
    if (names.length === 0) throw new Error("A food must have at least one name.");

    const foodPortions = normalizeFoodPortions(food.foodPortions);
    if (foodPortions.length === 0) throw new Error("A food must have at least one food portion.");

    return {
      ...food,
      names,
      foodNutrients: getFoodNutrients(food),
      foodPortions,
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

    const names = updates.names === undefined
      ? getFoodNames(existingFood)
      : normalizeFoodNames(updates.names);
    if (names.length === 0) throw new Error("A food must have at least one name.");

    const foodPortions = updates.foodPortions === undefined
      ? getFoodPortions(existingFood)
      : normalizeFoodPortions(updates.foodPortions);
    if (foodPortions.length === 0) throw new Error("A food must have at least one food portion.");

    await this.collection().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          ...updates,
          names,
          foodNutrients: updates.foodNutrients === undefined
            ? getFoodNutrients(existingFood)
            : normalizeFoodNutrients(updates.foodNutrients),
          foodPortions,
        },
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
