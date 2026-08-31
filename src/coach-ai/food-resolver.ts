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




export class FoodLogResolver {
  constructor(
    private readonly foodDatabase: LocalFoodSearch = FoodDatabase
  ) { }



    /**
     * Searches branded, Foundation, SR Legacy, and survey records before
     * accepting a result. Every selected result must contain every meaningful
     * query term, including a brand name such as "Jamba".
     */
    async findVerifiedFood(query: string): Promise<UsdaFood | null> {
      console.log("[Food log] searching for compatable USDA food.", { query});
      const candidates = await UsdaFoodDataApi.getMatchingFoodCandidates(query);
      console.log(`[Food log] Found ${candidates.length} USDA food candidates:`, { candidates: candidates.map(c => c.description) });
      for (const candidate of candidates) {
        // const food = await UsdaFoodDataApi.getFoodById(candidate.fdcId);
        // if (!UsdaFoodDataApi.foodMatchesUsdaQuery(food, query)) {
        //   continue;
        // }

        // try {
        //   getUsdaMetricsPer100g(food);
        // } catch (error) {
        //   if (error instanceof UsdaFoodDataApiError) {
        //     continue;
        //   }
        //   throw error;
        // }
        // return food;
      }
      return null;
    }

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
    
    try {
      const verifiedFood = await this.findVerifiedFood(query);
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
