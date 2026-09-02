import { UsdaFood, UsdaFoodPortion } from "../api/usdaFoodDataApi";
import { LoggedFoodPortion } from "../utils/account-database";

const FALLBACK_GRAMS = 100;

const MASS_UNITS_IN_GRAMS: Record<string, number> = {
  mg: 0.001,
  milligram: 0.001,
  g: 1,
  gram: 1,
  kg: 1_000,
  kilogram: 1_000,
  oz: 28.349523125,
  ounce: 28.349523125,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
};

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Normalizes a measure for comparison and display. The application intentionally
 * does not convert volume to mass without a USDA portion weight for that food.
 */
export function normalizeFoodUnit(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:of\s+)?/, "");

  if (!normalized) return "serving";

  const aliases: Record<string, string> = {
    grams: "g",
    gram: "g",
    milligrams: "mg",
    milligram: "mg",
    kilograms: "kg",
    kilogram: "kg",
    ounces: "oz",
    ounce: "oz",
    pounds: "lb",
    pound: "lb",
    tbsp: "tbsp",
    tablespoons: "tbsp",
    tablespoon: "tbsp",
    tsp: "tsp",
    teaspoons: "tsp",
    teaspoon: "tsp",
    cups: "cup",
    pieces: "piece",
    pcs: "piece",
    pc: "piece",
    each: "piece",
    ea: "piece",
    chips: "chip",
    servings: "serving",
    cookies: "cookie",
    candies: "candy",
    crackers: "cracker",
    slices: "slice",
    bars: "bar",
    sticks: "stick",
    eggs: "egg",
    brownies: "brownie",
    pies: "pie",
  };
  if (aliases[normalized]) return aliases[normalized];

  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("s") && !normalized.endsWith("ss")) return normalized.slice(0, -1);
  return normalized;
}

function massToGrams(amount: number, unit: string): number | undefined {
  const multiplier = MASS_UNITS_IN_GRAMS[normalizeFoodUnit(unit)];
  return multiplier === undefined ? undefined : amount * multiplier;
}

function portionLabels(portion: UsdaFoodPortion): string[] {
  return [
    portion.measureUnit?.name,
    portion.measureUnit?.abbreviation,
    portion.modifier,
    portion.portionDescription,
  ]
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    .map(label => label.trim().toLowerCase());
}

function labelMatchScore(label: string, unit: string): number {
  if (normalizeFoodUnit(label) === unit) return 3;

  const words = label.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(word => normalizeFoodUnit(word) === unit) ? 2 : 0;
}

function gramsFromFoodPortions(food: UsdaFood, amount: number, unit: string): number | undefined {
  const candidates = (food.foodPortions ?? [])
    .filter(portion => isPositiveFiniteNumber(portion.gramWeight))
    .map(portion => ({
      portion,
      labels: portionLabels(portion),
      score: Math.max(...portionLabels(portion).map(label => labelMatchScore(label, unit)), 0),
    }))
    .filter(({ score }) => score > 0);

  if (candidates.length === 0) return undefined;

  const best = candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    // Prefer a portion explicitly described in the requested unit over a
    // broad modifier such as "small" that happened to contain that word.
    return right.labels.length - left.labels.length;
  })[0].portion;
  const portionAmount = isPositiveFiniteNumber(best.amount) ? best.amount : 1;
  return amount * best.gramWeight! / portionAmount;
}

interface HouseholdServing {
  amount: number;
  unit: string;
}

function parseHouseholdAmount(value: string): number | undefined {
  const mixedFraction = value.match(/^(\d+(?:\.\d+)?)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixedFraction) {
    const whole = Number(mixedFraction[1]);
    const numerator = Number(mixedFraction[2]);
    const denominator = Number(mixedFraction[3]);
    return denominator > 0 ? whole + (numerator / denominator) : undefined;
  }

  const fraction = value.match(/^(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator > 0 ? numerator / denominator : undefined;
  }

  const decimal = Number(value);
  return isPositiveFiniteNumber(decimal) ? decimal : undefined;
}

function householdServingFromText(value: string | undefined): HouseholdServing | undefined {
  if (!value) return undefined;

  // Examples in FDC include "15 chips", "2 cookies (30 g)", and
  // "1 1/2 cups". Only the quantity/unit before a parenthetical gram value
  // describes the household measure for the serving.
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*([a-zA-Z][a-zA-Z .-]*)/g)];
  for (const match of matches) {
    const amount = parseHouseholdAmount(match[1]);
    const unit = normalizeFoodUnit(match[2].replace(/\s*\(.*/, "").trim());
    if (isPositiveFiniteNumber(amount) && !massToGrams(1, unit)) {
      return { amount, unit };
    }
  }

  return undefined;
}

function brandedServingGrams(food: UsdaFood): number | undefined {
  if (!isPositiveFiniteNumber(food.servingSize) || typeof food.servingSizeUnit !== "string") {
    return undefined;
  }
  return massToGrams(food.servingSize, food.servingSizeUnit);
}

function gramsFromBrandedServing(food: UsdaFood, amount: number, unit: string): number | undefined {
  const servingGrams = brandedServingGrams(food);
  if (servingGrams === undefined) return undefined;
  if (unit === "serving") return amount * servingGrams;

  const householdServing = householdServingFromText(food.householdServingFullText);
  if (householdServing && householdServing.unit === unit) {
    return amount * servingGrams / householdServing.amount;
  }

  return undefined;
}

/**
 * Resolves the quantity a person entered to grams. It first handles explicit
 * mass, then USDA's food-specific portions, then branded label serving data;
 * only an unresolved household measure falls back to 100 g.
 */
export function resolveUsdaFoodPortion(
  food: UsdaFood,
  amount: number,
  rawUnit: string,
): LoggedFoodPortion {
  if (!isPositiveFiniteNumber(amount)) {
    throw new Error("A food portion amount must be a positive number.");
  }

  const unit = normalizeFoodUnit(rawUnit);
  const explicitMassGrams = massToGrams(amount, unit);
  if (explicitMassGrams !== undefined) {
    return { amount, unit, grams: explicitMassGrams, source: "explicit-mass" };
  }

  const foodPortionGrams = gramsFromFoodPortions(food, amount, unit);
  if (foodPortionGrams !== undefined) {
    return { amount, unit, grams: foodPortionGrams, source: "usda-food-portion" };
  }

  const brandedGrams = gramsFromBrandedServing(food, amount, unit);
  if (brandedGrams !== undefined) {
    return { amount, unit, grams: brandedGrams, source: "branded-serving" };
  }

  // We do not know the size of an unresolved unit. Applying the entered count
  // to an arbitrary 100 g estimate recreates the very over-counting this
  // resolver prevents, so the final fallback is one explicit 100 g estimate.
  return { amount, unit, grams: FALLBACK_GRAMS, source: "fallback" };
}
