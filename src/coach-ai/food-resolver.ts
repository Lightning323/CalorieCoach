
import {
  getUsdaMetricsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
} from "../api/usdaFoodDataApi";

import {
  FoodDatabase,
  FoodSearchCandidate,
  getFoodNameMatchScore,
} from "../utils/food-database";

import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";

import {
  FoodLogProgressListener,
  ResolvedFoodLog,
  readPortionUnit,
  readPositiveNumber,
  reportProgress,
  scaleFoodMetricsPer100g,
} from "./types";

const MAX_LOCAL_MATCH_CANDIDATES = 10;
const CONFIDENCE_THRESHOLD = 0.86;






export class FoodLogResolver {
  constructor(
    private readonly foodDatabase = FoodDatabase,
    private readonly parser = new FoodLLM(),
  ) { }



  async findLocalMatch(entry: FoodLogParserEntry): Promise<FoodSearchCandidate | null> {
    let indx = 0;
    for (const query of entry.food_queries ?? []) { //Go through each alias and see if any of them have a saved food match
      indx++;
      //Since we havent seen USDA match yet, we dont want to try too hard to get a database match.
      if (indx > Math.max(1, entry.food_queries!.length * 0.6)) break;

      const localCandidates = await this.foodDatabase.searchFoodCandidates(
        query,
        MAX_LOCAL_MATCH_CANDIDATES,
        0,
      );
      console.log(`[Food log] database matches for: ${query} (${indx} / ${entry.food_queries!.length})`, { localCandidates: localCandidates.map(local => local.toString()) });

      let localMatch = null;
      //The items are already sorted by confidence, so the first one is the best match. If it's below the threshold, ignore it.
      if (localCandidates.length > 0) {
        localMatch = localCandidates[0];
        if (localMatch.confidence < CONFIDENCE_THRESHOLD) {
          localMatch = null;
        }
      }
      if (localMatch) return localMatch;
    }
    return null;
  }

  async findUsdaMatch(entry: FoodLogParserEntry): Promise<UsdaFood | null> {
    for (const query of entry.food_queries ?? []) {
      const aliasCandidates = await UsdaFoodDataApi.getMatchingFoodCandidates(query);
      console.log(`[Food log] Found ${aliasCandidates.length} USDA food candidates for "${query}"`);
      for (const c of aliasCandidates) {
        let confidenceScore = getFoodNameMatchScore(query, [c.description]);
        console.log(`[Food log] \t"${c.description}", confidence: ${confidenceScore}`);
        if (confidenceScore >= CONFIDENCE_THRESHOLD) {
          return c;
        }
      }
    }
    return null;
  }


  async resolve(
    entry: FoodLogParserEntry,
    onProgress?: FoodLogProgressListener,
    progress = 55,
  ): Promise<ResolvedFoodLog | null> {

    const hasLegacyGramAmount = entry.grams !== undefined;
    const amount = entry.quantity !== undefined
      ? readPositiveNumber(entry.quantity)
      : readPositiveNumber(entry.grams, 1);
    const unit = entry.unit !== undefined
      ? readPortionUnit(entry.unit)
      : hasLegacyGramAmount ? "g" : "serving";


    //Check if the saved food is an exact match and has a compatible unit
    reportProgress(onProgress, progress, `Checking saved foods`);
    let localMatch = await this.findLocalMatch(entry);
    if (localMatch) {
      console.log("[Food log] Local Database match result:", { names: localMatch?.item.names, confidence: localMatch?.confidence });
      return {
        food: localMatch.item,
        quantity: amount,
        saveFood: false,
      };
    }

    // If no saved food is found, query USDA FoodData Central for a verified food profile
    reportProgress(onProgress, progress + 3, `Looking up in USDA FoodData Central.`);
    let verifiedFood = await this.findUsdaMatch(entry);
    if (verifiedFood) {
      console.log(`[Food log] USDA match result: ${JSON.stringify(verifiedFood, null, 2)}`);
      const metricsPer100g = getUsdaMetricsPer100g(verifiedFood);
      const metrics = scaleFoodMetricsPer100g(metricsPer100g, entry.grams);
      // console.log("[Food log] scaled USDA metrics:", { metrics });


      const description = verifiedFood.description;
      const brand = verifiedFood.brandName ?? verifiedFood.brandOwner;
      const displayName = brand && !description.toLowerCase().includes(brand.toLowerCase())
        ? `${brand}: ${description}`
        : description;
      const titleCase = displayName.toLowerCase()
        .split(" ")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");



      console.log("[Food log] using USDA food match.", {
        usdaFood: verifiedFood
      });
      let foodNames = [verifiedFood.description.toLocaleLowerCase()];
      foodNames.push(entry.food_queries?.[0] ?? "");
      return {
        food: {
          names: foodNames,
          quantity: `1 ${entry.unit}`,
          metrics,
          source: "USDA FoodData Central",
          sourceId: String(verifiedFood.fdcId),
        },
        quantity: entry.quantity,
        saveFood: true,
      };
    }
    console.log("[Food log] No match found.");
    let metrics = await this.parser.guessNutritionalMetrics(entry);
    return {
      food: {
        names: entry.food_queries ?? [],
        quantity: `1 ${entry.unit}`,
        metrics,
        source: "LLM Estimate"
      },
      quantity: entry.quantity,
      saveFood: true,
    };
  }
}
