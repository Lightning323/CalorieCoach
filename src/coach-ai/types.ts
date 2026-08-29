import { FoodLog, LoggedFoodPortion } from "../utils/account-database";
import { FoodItem, FoodMetrics } from "../utils/food-database";

/** The text parser's deliberately small, nutrition-free output contract. */
export interface FoodLogParserEntry {
  /** The exact food or product description, without its amount. */
  food_query?: unknown;
  /** Kept temporarily so a rolling deployment can read an older parser response. */
  usda_query?: unknown;
  quantity?: unknown;
  unit?: unknown;
  /** Kept temporarily for old responses that represented an amount in grams. */
  grams?: unknown;
  notes?: unknown;
}

export interface ExistingFoodLog extends Omit<FoodLog, "_id" | "logDate" | "foodItem_id" | "backup_foodItem" | "quantity" | "notes"> {
  food: FoodItem;
  quantity: number;
  notes: string;
  saveFood: false;
}

export interface NewFoodLog extends Omit<FoodLog, "_id" | "logDate" | "foodItem_id" | "backup_foodItem" | "quantity" | "notes"> {
  food: Omit<FoodItem, "_id">;
  quantity: number;
  notes: string;
  saveFood: true;
}

export type ResolvedFoodLog = ExistingFoodLog | NewFoodLog;

export interface FoodLogProgress {
  progress: number;
  message: string;
}

export interface LoggedFoodEntry {
  id: string;
  loggedAt: string;
  quantity: number;
  portion?: LoggedFoodPortion;
  notes: string;
  food: {
    names: string[];
    quantity: string;
    metrics: FoodMetrics;
  };
}

export interface FoodLogResult {
  success: boolean;
  message: string;
  entries: LoggedFoodEntry[];
}

export type FoodLogProgressListener = (progress: FoodLogProgress) => void;

export function scaleFoodMetrics(metrics: FoodMetrics, multiplier: number): FoodMetrics {
  return Object.fromEntries(
    Object.entries(metrics).map(([metric, value]) => [metric, value * multiplier]),
  );
}

export function readPositiveNumber(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("The food parser returned an invalid quantity.");
  }

  return number;
}

export function readPortionUnit(value: unknown, fallback = "serving"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new Error("The food parser returned an invalid portion unit.");
  }
  return value.trim();
}

export function readFoodQuery(entry: FoodLogParserEntry): string {
  const rawQuery = entry.food_query ?? entry.usda_query;
  const query = typeof rawQuery === "string" ? rawQuery.trim().replace(/\s+/g, " ") : "";
  if (!query || query.length > 160) {
    throw new Error("The food parser did not provide a valid food description.");
  }
  return query;
}

export function reportProgress(
  listener: FoodLogProgressListener | undefined,
  progress: number,
  message: string,
) {
  listener?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), message });
}
