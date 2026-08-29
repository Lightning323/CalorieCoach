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
    pieces: "piece",
    servings: "serving",
    cookies: "cookie",
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

function labelMatchesUnit(label: string, unit: string): boolean {
  if (normalizeFoodUnit(label) === unit) return true;

  const words = label.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(word => normalizeFoodUnit(word) === unit);
}

function gramsFromFoodPortions(food: UsdaFood, amount: number, unit: string): number | undefined {
  const candidates = (food.foodPortions ?? [])
    .filter(portion => isPositiveFiniteNumber(portion.gramWeight))
    .map(portion => ({
      portion,
      labels: portionLabels(portion),
    }))
    .filter(({ labels }) => labels.some(label => labelMatchesUnit(label, unit)));

  if (candidates.length === 0) return undefined;

  const best = candidates.sort((left, right) => {
    const leftExact = left.labels.includes(unit) ? 1 : 0;
    const rightExact = right.labels.includes(unit) ? 1 : 0;
    return rightExact - leftExact;
  })[0].portion;
  const portionAmount = isPositiveFiniteNumber(best.amount) ? best.amount : 1;
  return amount * best.gramWeight! / portionAmount;
}

interface HouseholdServing {
  amount: number;
  unit: string;
}

function householdServingFromText(value: string | undefined): HouseholdServing | undefined {
  if (!value) return undefined;

  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z][a-zA-Z .-]*)/g)];
  for (const match of matches) {
    const amount = Number(match[1]);
    const unit = normalizeFoodUnit(match[2].replace(/\s*\(.*/, "").trim());
    if (isPositiveFiniteNumber(amount) && !MASS_UNITS_IN_GRAMS[unit]) {
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

  return { amount, unit, grams: amount * FALLBACK_GRAMS, source: "fallback" };
}
