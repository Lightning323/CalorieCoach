import { FoodNutrients } from "./food-database";

type LoggedPortionWeight = { gramWeight?: number; grams?: number } | null | undefined;

/** Canonical multiplier for nutrition stored per 100 g. */
export function loggedFoodNutritionMultiplier(quantity: number, portion: LoggedPortionWeight): number {
  const grams = Number(portion?.gramWeight ?? portion?.grams);
  return Number.isFinite(grams) && grams > 0 ? grams * quantity / 100 : quantity;
}

export function scaleLoggedFoodNutrients(foodNutrients: FoodNutrients, quantity: number, portion: LoggedPortionWeight): FoodNutrients {
  const multiplier = loggedFoodNutritionMultiplier(quantity, portion);
  return Object.fromEntries(Object.entries(foodNutrients).map(([name, value]) => [name, value * multiplier]));
}
