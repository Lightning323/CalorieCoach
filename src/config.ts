import "dotenv/config";

// FoodData Central nutrient IDs to record on each newly logged USDA food.
// Add or remove entries here to customize the metric set stored by the logger.
export const TRACKED_NUTRIENTS: Record<number, string> = {
  1008: "calories",
  1003: "protein",
  1005: "carbs",
  1079: "fiber",
  2000: "sugars",
  1004: "fat",
  1092: "potassium",
  1093: "sodium",
  1090: "magnesium",
  1089: "iron",
  1095: "zinc",
  1175: "vitamin_b6",
  1178: "vitamin_b12",
  1162: "vitamin_c",
  1114: "vitamin_d",
};

/**
 * Compact daily nutrient targets shown on the dashboard. These are general
 * reference values for adults, not individualized medical recommendations.
 * Keeping the presentation data here lets the server and view stay aligned
 * as the dashboard grows.
 */
export const WELLNESS_NUTRIENT_GOALS = [
  { key: "fiber", label: "Fiber", shortLabel: "Fi", target: 28, unit: "g", color: "teal" },
  { key: "iron", label: "Iron", shortLabel: "Fe", target: 18, unit: "mg", color: "orange" },
  { key: "zinc", label: "Zinc", shortLabel: "Zn", target: 11, unit: "mg", color: "violet" },
  { key: "magnesium", label: "Magnesium", shortLabel: "Mg", target: 420, unit: "mg", color: "blue" },
  { key: "vitamin_c", label: "Vitamin C", shortLabel: "C", target: 90, unit: "mg", color: "green" },
  { key: "vitamin_d", label: "Vitamin D", shortLabel: "D", target: 20, unit: "mcg", color: "gold" },
  { key: "vitamin_b12", label: "Vitamin B12", shortLabel: "B12", target: 2.4, unit: "mcg", color: "rose" },
] as const;

export const APP_VERSION = "2.0.0";
export const DEFAULT_USERNAME = process.env.DEFAULT_USERNAME ?? "Lightning323";

export function getAppVersion() {
  return APP_VERSION;
}


export const REQUIRED_FOOD_NUTRIENTS = ["calories", "protein", "carbs", "fat"] as const;

function getPort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8080;
}

export const config = {
  port: getPort(process.env.PORT),
  /** Optional protection for the public read API. */
  apiKey: process.env.CALORIE_COACH_API_KEY,
  defaultUsername: DEFAULT_USERNAME,
  appVersion: getAppVersion(),
};
