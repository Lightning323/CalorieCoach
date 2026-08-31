import {
  getUsdaMetricsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
} from "../api/usdaFoodDataApi";
import { resolveUsdaFoodPortion, normalizeFoodUnit } from "../services/food-portion-service";
import {
  FoodDatabase,
  FoodItem,
  FoodSearchCandidate,
  getFoodNames,
  getPrimaryFoodName,
  normalizeFoodNames,
} from "../utils/food-database";
import {
  FoodLogParserEntry,
  FoodLogProgressListener,
  ResolvedFoodLog,
  readFoodQuery,
  readPortionUnit,
  readPositiveNumber,
  reportProgress,
  scaleFoodMetrics,
} from "./types";

const MAX_LOCAL_MATCH_CANDIDATES = 10;
const MIN_SAFE_LOCAL_MATCH_CONFIDENCE = 0.86;

interface LocalFoodSearch {
  searchFoodCandidates(
    name: string,
    maxResults?: number,
    minConfidence?: number,
  ): Promise<FoodSearchCandidate[]>;
}

interface UsdaFoodVerifier {
  findVerifiedFood(query: string): Promise<UsdaFood>;
}



function declaredUnit(food: FoodItem): string | undefined {
  const match = food.quantity.trim().match(/^1(?:\.0+)?\s+(.+)$/i);
  return match ? normalizeFoodUnit(match[1]) : undefined;
}

function normalizedFoodName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A saved alias that exactly matches the person's parsed food text is authoritative. */
function hasExactSavedFoodName(food: FoodItem, query: string): boolean {
  const normalizedQuery = normalizedFoodName(query);
  return getFoodNames(food).some(name => normalizedFoodName(name) === normalizedQuery);
}

/**
 * The requested amount can use a saved food only when its unit is compatible
 * with that food's stored one-serving nutrition. A generic "serving" means
 * one declared serving, regardless of how the saved food labels it.
 */
function hasCompatibleSavedFoodUnit(food: FoodItem, requestedUnit: string): boolean {
  const normalizedRequestedUnit = normalizeFoodUnit(requestedUnit);
  if (normalizedRequestedUnit === "serving") return true;

  const storedUnit = declaredUnit(food);
  return storedUnit === normalizedRequestedUnit;
}

export class FoodLogResolver {
  constructor(
    private readonly foodDatabase: LocalFoodSearch = FoodDatabase,
    private readonly usdaFoodData: UsdaFoodVerifier = UsdaFoodDataApi,
  ) { }

  async resolve(
    entry: FoodLogParserEntry,
    onProgress?: FoodLogProgressListener,
    progress = 55,
  ): Promise<ResolvedFoodLog | null> {
    const query = readFoodQuery(entry);
    const hasLegacyGramAmount = entry.grams !== undefined;
    const amount = entry.quantity !== undefined
      ? readPositiveNumber(entry.quantity)
      : readPositiveNumber(entry.grams, 1);
    const unit = entry.unit !== undefined
      ? readPortionUnit(entry.unit)
      : hasLegacyGramAmount ? "g" : "serving";


    //Check if the saved food is an exact match and has a compatible unit
    reportProgress(onProgress, progress, `Checking saved foods for ${query}.`);
    const localCandidates = await this.foodDatabase.searchFoodCandidates(
      query,
      MAX_LOCAL_MATCH_CANDIDATES,
      0,
    );
    console.log("[Food log] existing database matches: ", {localCandidates: localCandidates.map(local => local.toString())});

    let localMatch = null;
    if (localCandidates.length > 0) {
      localMatch = localCandidates[0];
      if (localMatch.confidence < MIN_SAFE_LOCAL_MATCH_CONFIDENCE) {
        localMatch = null;
      }
    }

    if (localMatch) {
      return {
        food: localMatch.item,
        quantity: amount,
        notes: typeof entry.notes === "string" ? entry.notes : "",
        saveFood: false,
      };
    }

    // If no saved food is found, query USDA FoodData Central for a verified food profile
    reportProgress(onProgress, progress + 3, `Looking up ${query} in USDA FoodData Central.`);
    console.log("[Food log] starting USDA verification.", { query, amount, unit });
    try {
      const verifiedFood = await this.usdaFoodData.findVerifiedFood(query);
      const metricsPer100g = getUsdaMetricsPer100g(verifiedFood);
      const portion = resolveUsdaFoodPortion(verifiedFood, amount, unit);
      reportProgress(onProgress, progress + 6, `Verified nutrition for ${verifiedFood.description}.`);

      const description = verifiedFood.description;
      const brand = verifiedFood.brandName ?? verifiedFood.brandOwner;
      const displayName = brand && !description.toLowerCase().includes(brand.toLowerCase())
        ? `${brand}: ${description}`
        : description;
      const titleCase = displayName.toLowerCase()
        .split(" ")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      const gramsPerUnit = portion.grams / portion.amount;
      const metrics = scaleFoodMetrics(metricsPer100g, gramsPerUnit / 100);

      console.log("[Food log] using USDA food match.", {
        usdaFood: verifiedFood
      });
      return {
        food: {
          names: normalizeFoodNames([query, titleCase]),
          quantity: `1 ${portion.unit}`,
          metrics,
          source: "USDA FoodData Central",
          sourceId: String(verifiedFood.fdcId),
        },
        quantity: portion.amount,
        portion,
        notes: typeof entry.notes === "string" ? entry.notes : "",
        saveFood: true,
      };
    }
    catch (error) {
      console.error("[Food log] USDA verification failed.", { query, error });
      return null;
    }
  }
}
