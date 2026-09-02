import { Document, ObjectId } from "mongodb";
import { closeDB, connectDB, getDB } from "../db";
import {
  FoodNutrients,
  FoodPortion,
  normalizeFoodNames,
  normalizeFoodNutrients,
  normalizeFoodPortions,
} from "../utils/food-database";

type LegacyFoodDocument = Document & {
  _id?: ObjectId;
  names?: unknown;
  quantity?: unknown;
  metrics?: unknown;
  foodNutrients?: unknown;
  foodPortions?: unknown;
  calories?: unknown;
  protein?: unknown;
  carbs?: unknown;
  fat?: unknown;
};

type LegacyAccountDocument = Document & {
  _id: ObjectId;
  foods?: Array<Document & { backup_foodItem?: LegacyFoodDocument }>;
};

const LEGACY_NUTRIENT_FIELDS = ["calories", "protein", "carbs", "fat"] as const;

function foodNutrientsFromLegacyFood(food: LegacyFoodDocument): FoodNutrients {
  const current = normalizeFoodNutrients(food.foodNutrients);
  if (Object.keys(current).length > 0) return current;

  const renamed = normalizeFoodNutrients(food.metrics);
  if (Object.keys(renamed).length > 0) return renamed;

  const nutrients: FoodNutrients = {};
  for (const name of LEGACY_NUTRIENT_FIELDS) {
    const value = food[name];
    if (typeof value === "number" && Number.isFinite(value)) nutrients[name] = value;
  }
  return nutrients;
}

function gramsFromLegacyServing(serving: string): number {
  const parentheticalGrams = serving.match(/\((\d+(?:\.\d+)?)\s*g(?:rams?)?\)/i);
  if (parentheticalGrams) return Number(parentheticalGrams[1]);

  const measure = serving.match(/^(\d+(?:\.\d+)?)\s*(mg|g|grams?|kg|kilograms?|oz|ounces?|lb|lbs|pounds?)\b/i);
  if (!measure) return 100;

  const amount = Number(measure[1]);
  const unit = measure[2].toLowerCase();
  const multipliers: Record<string, number> = {
    mg: 0.001,
    g: 1,
    gram: 1,
    grams: 1,
    kg: 1_000,
    kilogram: 1_000,
    kilograms: 1_000,
    oz: 28.349523125,
    ounce: 28.349523125,
    ounces: 28.349523125,
    lb: 453.59237,
    lbs: 453.59237,
    pound: 453.59237,
    pounds: 453.59237,
  };
  return amount * (multipliers[unit] ?? 100);
}

function portionsFromLegacyServing(value: unknown): FoodPortion[] {
  const serving = typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : "1 serving";
  const grams = gramsFromLegacyServing(serving);
  const portions: FoodPortion[] = [{ unit: serving, grams, rank: 1 }];

  // Old records supplied one serving string. Retain it and add a mass measure
  // so every migrated record exposes more than one selectable portion.
  if (serving.toLowerCase() === "100 grams") {
    portions.push({ unit: "1 gram", grams: 1, rank: 2 });
  } else {
    portions.push({ unit: "100 grams", grams: 100, rank: 2 });
  }
  return portions;
}

function foodPortionsFromLegacyFood(food: LegacyFoodDocument): FoodPortion[] {
  const portions = normalizeFoodPortions(food.foodPortions);
  if (portions.length >= 2) return portions;

  if (portions.length === 1) {
    const portion = portions[0];
    return portion.unit.toLowerCase() === "100 grams"
      ? [portion, { unit: "1 gram", grams: 1, rank: portion.rank + 1 }]
      : [portion, { unit: "100 grams", grams: 100, rank: portion.rank + 1 }];
  }

  return portionsFromLegacyServing(food.quantity);
}

function migrateFoodDocument(food: LegacyFoodDocument): Document {
  const {
    quantity: _quantity,
    metrics: _metrics,
    calories: _calories,
    protein: _protein,
    carbs: _carbs,
    fat: _fat,
    foodNutrients: _foodNutrients,
    foodPortions: _foodPortions,
    names: rawNames,
    ...rest
  } = food;

  const names = normalizeFoodNames(Array.isArray(rawNames) ? rawNames : []);
  if (names.length === 0) {
    throw new Error(`Food ${food._id?.toHexString() ?? "without an id"} has no valid names.`);
  }

  return {
    ...rest,
    names,
    foodNutrients: foodNutrientsFromLegacyFood(food),
    foodPortions: foodPortionsFromLegacyFood(food),
  };
}

async function migrateFoodCollection(): Promise<number> {
  const collection = getDB().collection<LegacyFoodDocument>("food");
  const foods = await collection.find({}).toArray();

  for (const food of foods) {
    const migrated = migrateFoodDocument(food);
    await collection.replaceOne({ _id: food._id }, migrated);
  }

  return foods.length;
}

async function migrateAccountFoodSnapshots(): Promise<number> {
  const collection = getDB().collection<LegacyAccountDocument>("accounts");
  const accounts = await collection.find({ "foods.backup_foodItem": { $exists: true } }).toArray();
  let migratedSnapshots = 0;

  for (const account of accounts) {
    const foods = (account.foods ?? []).map(log => {
      if (!log.backup_foodItem) return log;
      migratedSnapshots++;
      return { ...log, backup_foodItem: migrateFoodDocument(log.backup_foodItem) };
    });
    await collection.updateOne({ _id: account._id }, { $set: { foods } });
  }

  return migratedSnapshots;
}

async function verifyMigration(): Promise<void> {
  const legacyFoodFields = {
    $or: [
      { quantity: { $exists: true } },
      { metrics: { $exists: true } },
      { calories: { $exists: true } },
      { protein: { $exists: true } },
      { carbs: { $exists: true } },
      { fat: { $exists: true } },
      { foodNutrients: { $exists: false } },
      { foodPortions: { $exists: false } },
    ],
  };
  const [remainingFoods, remainingSnapshots] = await Promise.all([
    getDB().collection("food").countDocuments(legacyFoodFields),
    getDB().collection("accounts").countDocuments({
      $or: [
        { "foods.backup_foodItem.quantity": { $exists: true } },
        { "foods.backup_foodItem.metrics": { $exists: true } },
        { "foods.backup_foodItem.calories": { $exists: true } },
        { "foods.backup_foodItem.protein": { $exists: true } },
        { "foods.backup_foodItem.carbs": { $exists: true } },
        { "foods.backup_foodItem.fat": { $exists: true } },
        { "foods.backup_foodItem.foodNutrients": { $exists: false } },
        { "foods.backup_foodItem.foodPortions": { $exists: false } },
      ],
    }),
  ]);

  if (remainingFoods || remainingSnapshots) {
    throw new Error(
      `Migration verification failed: ${remainingFoods} food records and ${remainingSnapshots} account snapshots still use the old schema.`,
    );
  }
}

async function main() {
  await connectDB();
  try {
    const foods = await migrateFoodCollection();
    const snapshots = await migrateAccountFoodSnapshots();
    await verifyMigration();
    console.log(`Migrated ${foods} food records and ${snapshots} account food snapshots.`);
  } finally {
    await closeDB();
  }
}

main().catch(error => {
  console.error("Food schema migration failed:", error);
  process.exitCode = 1;
});
