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
import { FoodLogLogger } from "./food-log-logger";
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

function describeCandidate(candidate: FoodSearchCandidate) {
  return {
    id: candidate.item._id?.toHexString(),
    name: getPrimaryFoodName(candidate.item),
    aliases: getFoodNames(candidate.item),
    serving: candidate.item.quantity,
    confidence: Number(candidate.confidence.toFixed(3)),
  };
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
  ) {}

  async resolve(
    entry: FoodLogParserEntry,
    logger: FoodLogLogger,
    onProgress?: FoodLogProgressListener,
    progress = 55,
  ): Promise<ResolvedFoodLog> {
    const query = readFoodQuery(entry);
    // A missing amount means one serving. Only a real legacy `grams` field
    // establishes grams; treating every omitted quantity as grams caused
    // saved foods such as PBH (1 serving) to be rejected before USDA.
    const hasLegacyGramAmount = entry.grams !== undefined;
    const amount = entry.quantity !== undefined
      ? readPositiveNumber(entry.quantity)
      : readPositiveNumber(entry.grams, 1);
    const unit = entry.unit !== undefined
      ? readPortionUnit(entry.unit)
      : hasLegacyGramAmount ? "g" : "serving";

    reportProgress(onProgress, progress, `Checking saved foods for ${query}.`);
    logger.info("Looking for a saved food before using USDA.", { query, amount, unit });
    const localCandidates = await this.foodDatabase.searchFoodCandidates(
      query,
      MAX_LOCAL_MATCH_CANDIDATES,
      0,
    );
    logger.debug("Saved-food search completed.", {
      query,
      resultCount: localCandidates.length,
      candidates: localCandidates.map(describeCandidate),
    });

    const exactLocalMatch = localCandidates.find(candidate => hasExactSavedFoodName(candidate.item, query));
    const localMatch = exactLocalMatch ?? localCandidates.find(candidate =>
      candidate.confidence >= MIN_SAFE_LOCAL_MATCH_CONFIDENCE &&
      hasCompatibleSavedFoodUnit(candidate.item, unit),
    );
    if (localMatch) {
      const food = localMatch.item;
      reportProgress(onProgress, progress + 3, `Using saved food: ${getPrimaryFoodName(food)}.`);
      logger.info("Resolved entry from the saved-food database; USDA was not called.", {
        query,
        amount,
        requestedUnit: unit,
        matchKind: localMatch === exactLocalMatch ? "exact saved alias" : "high-confidence compatible match",
        storedUnit: declaredUnit(food),
        selected: describeCandidate(localMatch),
      });
      return {
        food,
        quantity: amount,
        notes: typeof entry.notes === "string" ? entry.notes : "",
        saveFood: false,
      };
    }

    const rejectedLocalCandidates = localCandidates.map(candidate => ({
      ...describeCandidate(candidate),
      accepted: hasExactSavedFoodName(candidate.item, query) || (
        candidate.confidence >= MIN_SAFE_LOCAL_MATCH_CONFIDENCE &&
        hasCompatibleSavedFoodUnit(candidate.item, unit)
      ),
      rejection: hasExactSavedFoodName(candidate.item, query)
        ? "accepted exact saved alias"
        : candidate.confidence < MIN_SAFE_LOCAL_MATCH_CONFIDENCE
        ? `confidence below ${MIN_SAFE_LOCAL_MATCH_CONFIDENCE}`
        : `stored unit ${declaredUnit(candidate.item) ?? "unknown"} is incompatible with requested ${normalizeFoodUnit(unit)}`,
    }));
    logger.info("No safe saved-food match; USDA lookup is required.", {
      query,
      threshold: MIN_SAFE_LOCAL_MATCH_CONFIDENCE,
      candidates: rejectedLocalCandidates,
    });

    reportProgress(onProgress, progress + 3, `Looking up ${query} in USDA FoodData Central.`);
    logger.info("Starting USDA verification.", { query, amount, unit });
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

    logger.info("Resolved entry from USDA and prepared a saved-food profile.", {
      query,
      fdcId: verifiedFood.fdcId,
      description: verifiedFood.description,
      brand: verifiedFood.brandName ?? verifiedFood.brandOwner,
      portion,
      savedServing: `1 ${portion.unit}`,
      metrics,
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
}
