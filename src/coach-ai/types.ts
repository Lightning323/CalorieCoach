import { FoodLog, LoggedFoodPortion } from "../utils/account-database";
import { FoodItem, FoodMetrics } from "../utils/food-database";



export interface ResolvedFoodLog extends Omit<FoodLog, "_id" | "logDate" | "foodItem_id" | "backup_foodItem" | "quantity" | "notes"> {
  food: FoodItem;
  quantity: number;
  saveFood: boolean;
}

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

/** Scales USDA nutrition, which is reported per 100 grams, to a portion in grams. */
export function scaleFoodMetricsPer100g(metrics: FoodMetrics, grams: number): FoodMetrics {
  const multiplier = grams / 100;
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



export function reportProgress(
  listener: FoodLogProgressListener | undefined,
  progress: number,
  message: string,
) {
  listener?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), message });
}
