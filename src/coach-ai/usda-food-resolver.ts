import {
  getUsdaFoodNutrientsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
  UsdaFoodPortion,
} from "../api/usdaFoodDataApi";
import { FoodItem, FoodPortion, getFoodPortions } from "../utils/food-database";
import { keywordSimilarity } from "../utils/utils";
import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";
import { readPortionUnit, readPositiveNumber } from "./types";
import { normalizeFoodUnit, resolveUsdaFoodPortion } from "../services/food-portion-service";
import { generateJson } from "../api/llmApi";
import { FoodLog, LoggedFoodPortion } from "../utils/account-database";

interface UsdaFoodRepository {
  getFoodCandidates(query: string, maxResults?: number): Promise<UsdaFood[]>;
  getFoodById(fdcId: number): Promise<UsdaFood>;
}

const MAX_USDA_QUERIES = 3;
const MAX_USDA_CANDIDATES_PER_QUERY = 12;
const MAX_USDA_CANDIDATES = 10;

interface UsdaFoodCandidateResult {
  candidates: UsdaFood[];
  candidateOffsets: number[];
  candidateString: string;
}

interface FoodCandidateMatch {
  food_index: number;
  candidate_match_index: number;
  portion?: {
    unit: string;
    gramWeight: number;
  }
}

function candidateQueries(entry: FoodLogParserEntry): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const value of entry.new_food_queries) {
    const query = value.trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;

    seen.add(key);
    queries.push(query);
    if (queries.length === MAX_USDA_QUERIES) break;
  }

  return queries;
}

function fdcIdFromFood(food: FoodItem): number | undefined {
  if (food.source !== "USDA FoodData Central") return undefined;

  const fdcId = Number(food.sourceId);
  return Number.isSafeInteger(fdcId) && fdcId > 0 ? fdcId : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function gramsFromServingSize(food: UsdaFood): number | undefined {
  if (!isPositiveFiniteNumber(food.servingSize)) return undefined;

  const gramsPerUnit: Record<string, number> = {
    mg: 0.001,
    g: 1,
    gram: 1,
    kg: 1_000,
    oz: 28.349523125,
    ounce: 28.349523125,
    lb: 453.59237,
    pound: 453.59237,
  };
  const gramsPerServingUnit = gramsPerUnit[normalizeFoodUnit(food.servingSizeUnit ?? "g")];
  return gramsPerServingUnit ? food.servingSize * gramsPerServingUnit : undefined;
}

function portionUnit(portion: UsdaFoodPortion): string | undefined {
  const measureUnit = portion.measureUnit?.name ?? portion.measureUnit?.abbreviation;
  if (measureUnit && isPositiveFiniteNumber(portion.amount)) {
    return `${portion.amount} ${measureUnit}`;
  }

  return portion.disseminationText
    ?? portion.portionDescription
    ?? portion.modifier
    ?? measureUnit;
}

/** Converts USDA portions into the database's USDA-compatible portion shape. */
export function foodPortionsFromUsda(food: UsdaFood): FoodPortion[] {
  const portions: FoodPortion[] = [];
  const measures = food.foodPortions ?? food.foodMeasures ?? [];

  measures.forEach((portion, index) => {
    const unit = portionUnit(portion)?.trim();
    if (!unit || !isPositiveFiniteNumber(portion.gramWeight)) return;

    portions.push({ ...portion, rank: Number.isInteger(portion.rank) && portion.rank! > 0 ? portion.rank! : index + 1 });
  });

  if (portions.length === 0) {
    const grams = gramsFromServingSize(food);
    if (grams) portions.push({ amount: 1, gramWeight: grams, portionDescription: "1 serving", rank: 1 });
  }

  // FoodData Central nutrient values are reported per 100 g. Preserve that
  // canonical measure in every stored profile so portion weights can scale it.
  const hasHundredGramPortion = portions.some(portion =>
    portion.gramWeight === 100 && normalizeFoodUnit(portion.measureUnit?.name ?? portion.measureUnit?.abbreviation ?? "") === "g" && portion.amount === 100,
  );
  if (!hasHundredGramPortion) {
    portions.push({
      amount: 100,
      gramWeight: 100,
      measureUnit: { name: "gram", abbreviation: "g" },
      rank: Math.max(0, ...portions.map(portion => portion.rank ?? 0)) + 1,
    });
  }

  if (portions.length === 1) {
    portions.push({ amount: 1, gramWeight: 1, measureUnit: { name: "gram", abbreviation: "g" }, rank: (portions[0].rank ?? 0) + 1 });
  }

  return portions.sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
}

function unitFromFoodPortion(portion: FoodPortion): { amount: number; unit: string } | undefined {
  const amount = portion.amount;
  const unit = normalizeFoodUnit(portion.measureUnit?.name ?? portion.measureUnit?.abbreviation ?? "");
  return isPositiveFiniteNumber(amount) && unit ? { amount, unit } : undefined;
}

function storedFoodPortion(food: FoodItem, rawUnit: string): FoodPortion | undefined {
  const requestedUnit = normalizeFoodUnit(rawUnit);
  return getFoodPortions(food).find(portion => unitFromFoodPortion(portion)?.unit === requestedUnit);
}



/**
 * Collect, de-duplicate, and rank USDA results by their best score against
 * any parser-provided alias. The string is suitable for an LLM prompt or
 * diagnostic log and includes the USDA portion-measure metadata.
 */
async function findUsdaFoodCandidates(
  entries: FoodLogParserEntry[],
): Promise<UsdaFoodCandidateResult> {
  const candidates: UsdaFood[] = [];
  const candidateOffsets: number[] = [];
  const lines: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const foodsById = new Map<number, UsdaFood>();
    for (const query of candidateQueries(entry)) {
      const results = await UsdaFoodDataApi.getFoodCandidates(query, MAX_USDA_CANDIDATES_PER_QUERY);
      for (const food of results) {
        if (Number.isSafeInteger(food.fdcId) && food.fdcId > 0 && !foodsById.has(food.fdcId)) {
          foodsById.set(food.fdcId, food);
        }
      }
    }

    const ranked = [...foodsById.values()]
      .map(food => ({
        food,
        similarity: Math.max(...entry.new_food_queries.map(query => keywordSimilarity(query, food.description))),
      }))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, MAX_USDA_CANDIDATES);

    candidateOffsets.push(candidates.length);
    lines.push(`\n[${i}] "${entry.new_food_queries[0] ?? "unknown food"}":`);
    ranked.forEach(({ food }, index) => {
      candidates.push(food);
      const portions = foodPortionsFromUsda(food).slice(0, 3)
        .map(portion => `${portionUnit(portion)} (${portion.gramWeight} grams)`);
      lines.push(`${index + 1}. ${food.description}${portions.length ? `\n   units: ${portions.join(", ")}` : ""}`);
    });
  }

  return { candidates, candidateOffsets, candidateString: lines.join("\n") };
}





export async function resolveAll(entries: readonly FoodLogParserEntry[]): Promise<void> {
  const unresolvedEntries = entries.filter(entry => entry.database_food === null);
  const { candidates, candidateOffsets, candidateString } = await findUsdaFoodCandidates(unresolvedEntries);


  const prompt = `Choose the best USDA food candidate for the following food entries: 
    ${candidateString}
    
    Your output must be valid JSON and look like this:
    [
    {"food_index": number, "candidate_match_index": number, "portion": {"gramWeight":number, "unit":string}}, ...
    ]

RULES:
- portions
  - USE AN EXISTING RELEVANT PORTION IF THERE IS ONE!
  - If there are no portions in the food entry selected, make your own, and choose something other than generic "grams" if possible.
    `

  console.log("[Food log] USDA candidate prompt:\n", prompt);
  const output = await generateJson(prompt);
  console.log(JSON.stringify(output))

  if (!Array.isArray(output)) throw new Error("USDA matcher response was not a list.");

  for (const value of output as FoodCandidateMatch[]) {
    if (!Number.isInteger(value.food_index) || !Number.isInteger(value.candidate_match_index)) continue;

    const foodIndex = value.food_index
    const candidateIndex = candidateOffsets[value.food_index] + value.candidate_match_index - 1;

    if (foodIndex > 0 && foodIndex < unresolvedEntries.length &&
      candidateIndex > 0 && candidateIndex < candidates.length
    ) {
      const unresolvedEntry = unresolvedEntries[foodIndex];
      const candidate = candidates[candidateIndex];
      if (!unresolvedEntry || !candidate) continue;

      //Create new portions using AI
      let portions = foodPortionsFromUsda(candidate)
      if (value.portion) {
        const p = {
          measureUnit: {
            name: value.portion.unit
          },
          gramWeight: value.portion.gramWeight,
          rank: 100 //Lowest rank
        }
        portions.push(p);
        unresolvedEntry.portion = p;
      }

      //Add new database food to unresolved entries
      unresolvedEntry.database_food = {
        names: [candidate.description.toLowerCase()],//, ...unresolvedEntry.new_food_queries
        foodNutrients: getUsdaFoodNutrientsPer100g(candidate),
        foodPortions: portions,
        source: "USDA FoodData Central",
        sourceId: String(candidate.fdcId),
      };
      unresolvedEntry.saveFood = true
    }
  }
}

