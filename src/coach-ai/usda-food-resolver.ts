import {
  foodMatchesUsdaQuery,
  getUsdaFoodNutrientsPer100g,
  getUsdaSearchTerms,
  UsdaFood,
  UsdaFoodDataApi,
  UsdaFoodPortion,
} from "../api/usdaFoodDataApi";
import { FoodItem, FoodNutrients, FoodPortion, getFoodPortions, getFoodPortionName } from "../utils/food-database";
import { keywordSimilarity } from "../utils/utils";
import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";
import { readPortionUnit, readPositiveNumber } from "./types";
import {
  normalizeFoodUnit,
  resolveUsdaFoodPortion,
  usdaFoodIdFromStoredFood,
  usdaGramsPerUnit,
} from "../services/food-portion-service";
import { generateJsonArray } from "../api/llmApi";
import { FoodLog, LoggedFoodPortion } from "../utils/account-database";

/**
 * Supplies the grams in one unit of a measure a food does not have yet, so the
 * measure the person logged can be created instead of being replaced by an
 * unrelated one. May answer asynchronously (reading a food's USDA record).
 */
export type GramsPerUnitEstimator = (unit: string) => number | undefined | Promise<number | undefined>;

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
  /** Brand/restaurant qualifier words pooled per entry, for the relevance gate. */
  entryBrandTokens: Set<string>[];
}

interface FoodCandidateMatch {
  food_index: number;
  candidate_match_index: number | null;
  portion?: {
    unit: string;
    gramWeight: number;
  }
}

/** Plural-insensitive single-word normalization ("apples" -> "apple"). */
function normalizeTerm(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

/** All plural-insensitive significant words in a candidate's searchable text. */
function candidateFoodWords(candidate: UsdaFood): Set<string> {
  const foodText = [
    candidate.description,
    candidate.brandName,
    candidate.brandOwner,
    candidate.ingredients,
    candidate.additionalDescriptions,
    typeof candidate.foodCategory === "string" ? candidate.foodCategory : candidate.foodCategory?.description ?? "",
  ].filter((value): value is string => typeof value === "string").join(" ")
    .toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, " ");
  return new Set(foodText.split(/\s+/).filter(Boolean).map(normalizeTerm));
}

/** Brand/restaurant words pooled from every candidate for one entry. */
export function brandTokensFromCandidates(foods: UsdaFood[]): Set<string> {
  const tokens = new Set<string>();
  for (const food of foods) {
    for (const brand of [food.brandOwner, food.brandName]) {
      if (typeof brand !== "string") continue;
      for (const word of brand.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean)) {
        const normalized = normalizeTerm(word);
        if (normalized) tokens.add(normalized);
      }
    }
  }
  return tokens;
}

/**
 * Tiered relevance for a USDA candidate:
 * - tier 0 (exact): every significant query word is in the candidate.
 * - tier 1 (same food, generic): the candidate holds the query's head noun
 *   (usually the last word: "noodles" in "panda express noodles") and every
 *   other unmatched query word is a brand/restaurant qualifier seen in the
 *   entry's candidate pool. So generic "Noodles" is fine for "panda express
 *   noodles", but "Panda puff cereal" is not (head "express" missing).
 * - tier 2 (different food): anything else. Never picked.
 *
 * Note the head-noun rule alone cannot separate "Chicken soup" from "orange
 * chicken" (both share the head "chicken"), which is exactly why unmatched
 * non-head words must be brand qualifiers: "orange" never appears as a brand
 * token, so the soup stays vetoed, while "panda"/"express" do, so plain
 * noodles pass. A near-exact (>= 0.85) textual match is still accepted for
 * typos/plurals.
 */
export function usdaMatchTier(
  candidate: UsdaFood,
  entry: FoodLogParserEntry,
  brandTokens: Set<string> = new Set(),
): 0 | 1 | 2 {
  const primary = entry.new_food_queries[0]?.trim() || entry.new_food_queries.join(" ").trim();
  if (!primary) return 2;
  if (foodMatchesUsdaQuery(candidate, primary)) return 0;

  let terms: string[] = [];
  try {
    terms = getUsdaSearchTerms(primary).map(normalizeTerm).filter(Boolean);
  } catch {
    terms = [];
  }
  if (terms.length > 0) {
    const foodWords = candidateFoodWords(candidate);
    if (terms.every(term => foodWords.has(term))) return 0;

    // Same food under a generic name: head noun present, the rest only
    // brand/restaurant qualifiers (which a generic record has no reason to
    // carry). "panda express noodles" -> "Noodles": head "noodles" present,
    // "panda"/"express" are brand-pool tokens. "orange chicken" ->
    // "Chicken soup": "orange" is not a brand token, so it stays vetoed.
    const head = terms[terms.length - 1];
    if (head && foodWords.has(head)) {
      const restOk = terms.slice(0, -1).every(term => foodWords.has(term) || brandTokens.has(term));
      if (restOk) return 1;
    }
  }

  // Near-exact textual match (typos/plurals) still requires strong overlap.
  const candidateText = [candidate.description, candidate.brandOwner, candidate.brandName].filter(Boolean).join(" ");
  const bestSimilarity = entry.new_food_queries.length === 0 ? 0
    : Math.max(...entry.new_food_queries.map(query => keywordSimilarity(query, candidateText)));
  return bestSimilarity >= 0.85 ? 0 : 2;
}

/**
 * A USDA candidate is only relevant when it is the same food. Generic records
 * missing only brand qualifiers still count ("Noodles" for "panda express
 * noodles"); records missing the dish itself never do.
 */
export function isRelevantUsdaMatch(
  candidate: UsdaFood,
  entry: FoodLogParserEntry,
  brandTokens: Set<string> = new Set(),
): boolean {
  return usdaMatchTier(candidate, entry, brandTokens) < 2;
}

const CALORIE_EXPLICIT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:kcal|calories|calorie|cal)\b/i;
const CALORIE_UNIT_NAMES = new Set(["cal", "calorie", "calory", "kcal"]);

/** Calories the person stated outright ("azxyz bar, 30 kcal", "20 calories"). */
export function extractExplicitCalories(entry: FoodLogParserEntry): number | undefined {
  for (const query of entry.new_food_queries) {
    const match = query.match(CALORIE_EXPLICIT_PATTERN);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  // "20 calories" is sometimes parsed as quantity 20 of unit "calories".
  if (entry.unit && CALORIE_UNIT_NAMES.has(normalizeFoodUnit(entry.unit)) && Number.isFinite(entry.quantity) && entry.quantity > 0) {
    return entry.quantity;
  }
  return undefined;
}

/** Food name with an explicit "30 kcal" suffix stripped ("azxyz bar, 30 kcal" -> "azxyz bar"). */
export function cleanCalorieName(value: string): string {
  return value
    .replace(/,?\s*\d+(?:\.\d+)?\s*(?:kcal|calories|calorie|cal)\b/ig, "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-|]+|[,;:\-|]+$/g, "")
    .trim();
}

function fallbackFoodNames(entry: FoodLogParserEntry): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const query of entry.new_food_queries) {
    const cleaned = cleanCalorieName(query);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(cleaned);
    if (names.length >= 10) break;
  }
  if (names.length === 0) return ["Unnamed food"];
  return names;
}

/**
 * Builds a new food profile when no USDA candidate is relevant. The person's
 * own name and calorie statement win ("azxyz bar, 30 kcal" -> "azxyz bar" at
 * 30 kcal), other nutrients are AI-estimated, and the result is shaped exactly
 * like a USDA resolution (real portions, saveFood=true) so logging treats it
 * the same way.
 */
export async function createFallbackFood(entry: FoodLogParserEntry, estimator = new FoodLLM()): Promise<{ food: FoodItem; portion: FoodPortion }> {
  const explicitCalories = extractExplicitCalories(entry);
  const isCalorieOnlyUnit = entry.unit ? CALORIE_UNIT_NAMES.has(normalizeFoodUnit(entry.unit)) : false;
  const quantity = isCalorieOnlyUnit ? 1 : (Number.isFinite(entry.quantity) && entry.quantity > 0 ? entry.quantity : 1);
  const rawUnit = isCalorieOnlyUnit ? "serving" : (entry.unit?.trim() || "serving");
  const unit = normalizeFoodUnit(rawUnit) || "serving";
  const gramsPerUnit = expectedMassGramsForUnit(unit) ?? 100;

  let estimated: FoodNutrients = {};
  try {
    estimated = (await estimator.guessFoodNutrients(entry)) ?? {};
  } catch (error) {
    console.warn(`[Food log] Nutrient estimate failed for "${fallbackFoodNames(entry)[0]}":`, error);
  }

  const totalGrams = quantity * gramsPerUnit > 0 ? quantity * gramsPerUnit : 100;
  const toPer100g = (value: number): number => (value * 100) / totalGrams;
  const per100g: FoodNutrients = {};
  for (const [name, value] of Object.entries(estimated)) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) per100g[name] = toPer100g(number);
  }
  if (explicitCalories !== undefined) {
    per100g.calories = toPer100g(explicitCalories);
  }
  if (!Number.isFinite(per100g.calories)) per100g.calories = explicitCalories !== undefined ? toPer100g(explicitCalories) : 0;

  const portions: FoodPortion[] = [
    { amount: 1, measureUnit: { name: unit }, gramWeight: gramsPerUnit, rank: 1 },
  ];
  const isHundredGramBasis = gramsPerUnit === 100 && unit === "g";
  if (!isHundredGramBasis) {
    portions.push({ amount: 100, measureUnit: { name: "gram", abbreviation: "g" }, gramWeight: 100, rank: 2 });
  }
  if (portions.length === 1) {
    portions.push({ amount: 1, measureUnit: { name: "gram", abbreviation: "g" }, gramWeight: 1, rank: 2 });
  }

  return {
    food: {
      names: fallbackFoodNames(entry),
      foodNutrients: per100g,
      foodPortions: portions,
      source: "LLM Estimate",
    },
    portion: portions[0],
  };
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
  return usdaFoodIdFromStoredFood(food);
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
  // Use the same display name the index renders so the LLM copies a real,
  // food-specific measure (for example, "1 pancake") instead of a generic
  // "1 serving" when both fields exist.
  return getFoodPortionName(portion) || undefined;
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

/** Mass units where "1 <unit>" has a fixed gram weight. A portion like
 * "1 grams (150 g)" claims 1 g weighs 150 g, so it is never accurate. */
const MASS_GRAMS_PER_UNIT: Record<string, number> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

function stripLeadingAmount(value: string): string {
  return value.trim().replace(/^(\d+(?:\.\d+)?)\s+(.+)$/, "$2").trim();
}

/** Normalized unit for matching, ignoring a leading count such as "2 cups". */
export function normalizedUnitForComparison(rawUnit: string): string {
  const stripped = stripLeadingAmount(rawUnit);
  return normalizeFoodUnit(stripped || rawUnit);
}

function expectedMassGramsForUnit(normalizedUnit: string): number | undefined {
  return MASS_GRAMS_PER_UNIT[normalizedUnit];
}

/**
 * Measure names that describe a portion of food rather than the thing being
 * counted. These are the only units that may stand in for a measure the person
 * never gave, and they are never created as a new measure on a food.
 */
const GENERIC_MEASURE_UNITS = new Set(["serving", "portion", "unit"]);

export function isGenericMeasureUnit(rawUnit: string): boolean {
  return GENERIC_MEASURE_UNITS.has(normalizedUnitForComparison(rawUnit));
}

/**
 * Prepends a new AI-generated measure to the top of a food's list (rank 1).
 * AI-created measures outrank USDA ones so the unit the person logged stays
 * selectable first instead of being buried after the 100 g basis. Mutates
 * `portions`. Ranks stay positive whole numbers: existing measures shift down
 * by one to make room on top.
 */
function prependPortion(portions: FoodPortion[], fields: Omit<FoodPortion, "rank">): FoodPortion {
  for (const portion of portions) {
    portion.rank = (portion.rank ?? 0) + 1;
  }
  const created: FoodPortion = { ...fields, rank: 1 };
  portions.unshift(created);
  return created;
}

/**
 * Returns a portion of one fixed mass unit (for example "1 g" or "1 oz").
 * Reuses an existing measure when available; otherwise prepends a new one on
 * top so a mass-based log ("150 g of chicken") scales by its real weight
 * instead of collapsing onto the top (often 100 g) portion.
 */
function massPortionForUnit(portions: FoodPortion[], unit: string): FoodPortion | undefined {
  const normalized = normalizedUnitForComparison(unit);
  const gramsPerUnit = MASS_GRAMS_PER_UNIT[normalized];
  if (gramsPerUnit === undefined) return undefined;

  const existing = findMatchingExistingPortion(portions, normalized, gramsPerUnit);
  if (existing) return existing;

  return prependPortion(portions, {
    amount: 1,
    measureUnit: { name: normalized },
    gramWeight: gramsPerUnit,
  });
}

/** All normalized unit spellings a stored portion can be selected by. */
export function portionNormalizedUnits(portion: FoodPortion): string[] {
  const units = new Set<string>();

  const addUnit = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const stripped = stripLeadingAmount(value);
    for (const candidate of [value, stripped]) {
      const normalized = normalizeFoodUnit(candidate);
      if (normalized) units.add(normalized);
    }
  };

  addUnit(portion.measureUnit?.name);
  addUnit(portion.measureUnit?.abbreviation);

  for (const text of [portion.modifier, portion.portionDescription, portion.disseminationText]) {
    if (typeof text !== "string" || !text.trim()) continue;
    const normalizedFull = normalizeFoodUnit(stripLeadingAmount(text));
    if (normalizedFull) units.add(normalizedFull);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const normalizedWord = normalizeFoodUnit(word);
      if (normalizedWord) units.add(normalizedWord);
    }
  }

  return [...units];
}

export function gramsMatch(left: number, right: number): boolean {
  if (!isPositiveFiniteNumber(left) || !isPositiveFiniteNumber(right)) return false;
  if (left === right) return true;
  const diff = Math.abs(left - right);
  if (diff <= 0.5) return true;
  return diff / Math.max(left, right) <= 0.01;
}

function sortedByRank(portions: FoodPortion[]): FoodPortion[] {
  return [...portions].sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
}

/**
 * Finds the existing USDA portion an LLM-selected unit/weight refers to.
 * Generic mass units ("grams", "g", ...) match by weight so "grams (150 g)"
 * reuses the real "1 cup (150 g)" measure instead of creating a duplicate
 * "1 grams" portion. Specific units prefer a unit match (trusting the USDA
 * weight over an LLM guess), then fall back to a weight match.
 */
export function findMatchingExistingPortion(
  portions: FoodPortion[],
  rawUnit: string,
  gramWeight: number,
): FoodPortion | undefined {
  if (!isPositiveFiniteNumber(gramWeight)) return undefined;
  const requestedUnit = normalizedUnitForComparison(rawUnit);
  if (!requestedUnit) return undefined;

  const ranked = sortedByRank(portions).filter(portion => isPositiveFiniteNumber(portion.gramWeight));
  if (ranked.length === 0) return undefined;

  const unitAndGrams = ranked.filter(portion =>
    portionNormalizedUnits(portion).includes(requestedUnit) &&
    gramsMatch(portion.gramWeight!, gramWeight),
  );
  if (unitAndGrams.length > 0) return unitAndGrams[0];

  const isGenericMass = expectedMassGramsForUnit(requestedUnit) !== undefined;

  if (isGenericMass) {
    // For "grams"-style selections the weight identifies the real measure.
    const byWeight = ranked.filter(portion => gramsMatch(portion.gramWeight!, gramWeight));
    if (byWeight.length > 0) return byWeight[0];
    return undefined;
  }

  const byUnit = ranked.filter(portion => portionNormalizedUnits(portion).includes(requestedUnit));
  if (byUnit.length > 0) return byUnit[0];

  const byWeight = ranked.filter(portion => gramsMatch(portion.gramWeight!, gramWeight));
  if (byWeight.length > 0) return byWeight[0];

  return undefined;
}

/** Top (primary) portion: the lowest-ranked USDA measure. */
export function topFoodPortion(portions: FoodPortion[]): FoodPortion | undefined {
  return sortedByRank(portions)[0];
}

/** The lowest-ranked measure the food already has for a unit, if any. */
function findPortionForUnit(portions: FoodPortion[], requestedUnit: string): FoodPortion | undefined {
  if (!requestedUnit) return undefined;

  return sortedByRank(portions).find(portion => portionNormalizedUnits(portion).includes(requestedUnit));
}

/** Prepends a one-unit AI-generated measure to the top of a food's list. Mutates `portions`. */
function createPortion(portions: FoodPortion[], unit: string, gramWeight: number): FoodPortion {
  return prependPortion(portions, {
    amount: 1,
    measureUnit: { name: unit },
    gramWeight,
  });
}

function usableLlmPortion(
  llmPortion: { unit: string; gramWeight: number } | undefined | null,
): llmPortion is { unit: string; gramWeight: number } {
  return Boolean(
    llmPortion &&
    typeof llmPortion.unit === "string" &&
    llmPortion.unit.trim().length > 0 &&
    isPositiveFiniteNumber(llmPortion.gramWeight),
  );
}

/** Reads a unit string out of any LLM-returned portion shape. Handles the
 * database-match prompt shape `{unit: {measureUnit: string}}`, a plain
 * string, USDA shapes (`measureUnit.name`), and legacy `{unit: string}`. */
export function extractLlmPortionUnit(rawPortion: unknown): string | undefined {
  if (typeof rawPortion === "string") return rawPortion.trim() || undefined;
  if (!rawPortion || typeof rawPortion !== "object" || Array.isArray(rawPortion)) return undefined;
  const portion = rawPortion as Record<string, unknown>;

  const candidates: unknown[] = [
    portion.unit,
    portion.measureUnit,
    (portion.unit as Record<string, unknown> | undefined)?.measureUnit,
    (portion.unit as Record<string, unknown> | undefined)?.name,
    (portion.measureUnit as Record<string, unknown> | undefined)?.name,
    (portion.measureUnit as Record<string, unknown> | undefined)?.abbreviation,
    portion.modifier,
    portion.portionDescription,
    portion.disseminationText,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/** Reads a gram weight out of any LLM-returned portion shape. */
export function extractLlmPortionGrams(rawPortion: unknown): number | undefined {
  if (!rawPortion || typeof rawPortion !== "object" || Array.isArray(rawPortion)) return undefined;
  const portion = rawPortion as Record<string, unknown>;
  for (const key of ["gramWeight", "grams"]) {
    const value = Number(portion[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * The food's own portion array, re-normalized in place so a measure created
 * during resolution is stored with the food instead of being discarded along
 * with the copy `getFoodPortions` returns.
 */
function writableFoodPortions(food: Pick<FoodItem, "foodPortions">): FoodPortion[] {
  food.foodPortions = getFoodPortions(food);
  return food.foodPortions;
}

/**
 * Resolves an LLM-selected portion for an already-saved (database-matched)
 * food to the food's real stored portion object. Storing the raw LLM object
 * (for example `{unit: {measureUnit: "pancake"}}`) renders as "Serving" on
 * the index because display helpers cannot read that shape. Matching by
 * unit and weight keeps the logged name (for example, "pancake") correct.
 *
 * `preferredUnit` is the measure the person logged. Like a new food, an
 * existing database food gains that measure when it does not have one yet (for
 * example, "13 m&m's" onto a candy measured only as "1 serving", or "3 cups"
 * onto a food measured only as "100 g"), built from the portion the parser
 * already returned, or from `estimateGramsPerUnit` when the parser could not
 * weigh that measure. Mutates `food.foodPortions` when it does.
 */
export async function resolveDatabaseMatchPortion(
  food: Pick<FoodItem, "foodPortions"> | null | undefined,
  rawPortion: unknown,
  preferredUnit?: string,
  estimateGramsPerUnit?: GramsPerUnitEstimator,
): Promise<FoodPortion | undefined> {
  if (!food) return undefined;

  // A food with no measures at all keeps the caller's existing 100 g fallback.
  const portions = writableFoodPortions(food);
  if (portions.length === 0) return undefined;

  const unit = extractLlmPortionUnit(rawPortion);
  const grams = extractLlmPortionGrams(rawPortion);
  if (unit && grams !== undefined) {
    return selectResolvedPortion(portions, { unit, gramWeight: grams }, preferredUnit, estimateGramsPerUnit);
  }

  // A measure was named without a usable weight, so match on the name alone.
  for (const requestedUnit of [unit, preferredUnit]
    .filter((value): value is string => Boolean(value))
    .map(normalizedUnitForComparison)) {
    const match = findPortionForUnit(portions, requestedUnit);
    if (match) return match;
  }

  if (grams !== undefined) {
    const byWeight = sortedByRank(portions).find(portion => gramsMatch(portion.gramWeight!, grams));
    if (byWeight) return byWeight;
  }

  // Nothing named the measure the person logged, so create it from an estimate
  // rather than logging their count against an unrelated portion.
  if (preferredUnit) {
    const estimated = await selectResolvedPortion(portions, null, preferredUnit, estimateGramsPerUnit);
    if (estimated) return estimated;
  }

  return topFoodPortion(portions);
}

/** The grams in ONE unit of the measure the person logged, when that is known.
 *
 * A mass unit is fixed by definition. Otherwise the AI's weight is only usable
 * when it is expressed in the same measure, so a whole "1 serving" weight is
 * never recorded as the weight of a single candy. */
function gramsPerLoggedUnit(
  loggedUnit: string,
  llmPortion: { unit: string; gramWeight: number } | undefined | null,
): number | undefined {
  const massGrams = expectedMassGramsForUnit(loggedUnit);
  if (massGrams !== undefined) return massGrams;
  if (!usableLlmPortion(llmPortion)) return undefined;

  return normalizedUnitForComparison(llmPortion.unit) === loggedUnit ? llmPortion.gramWeight : undefined;
}

/**
 * Selects the portion to log (and store) for a food, whether newly resolved
 * from USDA or already in the database. Reuses an existing measure when the
 * selection refers to one, and creates the measure the person logged when the
 * food has none.
 *
 * The logged measure is authoritative: "13 m&m's" logs as 13 candies, not 13
 * of the food's generic "1 serving", and "3 cups" of a food stored only as
 * "100 g" logs as 3 cups. An existing measure in that unit always wins,
 * because its stored weight is better evidence than an AI guess; when the food
 * has no such measure one is created from the weight the AI already produced,
 * or from `estimateGramsPerUnit` (for example the food's own USDA record) when
 * the AI could not weigh that measure, so logging never costs an extra AI
 * call. A generic measure ("serving") or a mass unit ("g", "oz") never
 * triggers creation and keeps the previous behaviour: match the AI's portion
 * if it names a real measure, and otherwise fall back to the top portion.
 *
 * Mutates `portions` only when a genuinely new measure is created.
 */
export async function selectResolvedPortion(
  portions: FoodPortion[],
  llmPortion: { unit: string; gramWeight: number } | undefined | null,
  preferredUnit?: string,
  estimateGramsPerUnit?: GramsPerUnitEstimator,
): Promise<FoodPortion | undefined> {
  const loggedUnit = preferredUnit ? normalizedUnitForComparison(preferredUnit) : "";
  if (loggedUnit && !isGenericMeasureUnit(loggedUnit) && expectedMassGramsForUnit(loggedUnit) === undefined) {
    const existingLoggedUnit = findPortionForUnit(portions, loggedUnit);
    if (existingLoggedUnit) return existingLoggedUnit;

    const grams = gramsPerLoggedUnit(loggedUnit, llmPortion) ?? await estimateGramsPerUnit?.(loggedUnit);
    if (grams !== undefined) return createPortion(portions, loggedUnit, grams);
  }

  if (usableLlmPortion(llmPortion)) {
    const rawUnit = llmPortion.unit.trim().replace(/\s+/g, " ");
    const gramWeight = llmPortion.gramWeight;
    const existing = findMatchingExistingPortion(portions, rawUnit, gramWeight);
    if (existing) return existing;

    const normalizedUnit = normalizedUnitForComparison(rawUnit);
    const expectedMass = expectedMassGramsForUnit(normalizedUnit);
    const isInaccurateMassPortion = expectedMass !== undefined && !gramsMatch(expectedMass, gramWeight);
    if (isInaccurateMassPortion) {
      // The LLM guessed an implausible per-unit weight. When the user logged
      // by mass, one unit's weight is fixed, so record that exact measure
      // rather than collapsing the user's count onto the top portion.
      if (preferredUnit) {
        const massPortion = massPortionForUnit(portions, preferredUnit);
        if (massPortion) return massPortion;
      }
      return topFoodPortion(portions);
    }

    return createPortion(portions, normalizeFoodUnit(stripLeadingAmount(rawUnit)) || "serving", gramWeight);
  }

  if (preferredUnit) {
    const byUnit = findPortionForUnit(portions, normalizedUnitForComparison(preferredUnit));
    if (byUnit) return byUnit;
  }

  return topFoodPortion(portions);
}



export interface RankedUsdaCandidate {
  food: UsdaFood;
  similarity: number;
  /** 0 = exact, 1 = same food under a generic name, 2 = different food. */
  tier: 0 | 1 | 2;
  /** The candidate already lists the measure the person logged. */
  hasLoggedUnit: boolean;
  /** How many portion measures the candidate carries. */
  portionCount: number;
}

/**
 * Orders USDA candidates so the LLM meets the best options first: exact
 * identity before generic same-food records before different foods, and
 * within a tier the records that already list the logged unit (exact gram
 * weights beat AI estimates) and carry more measures first. A unit-rich
 * generic ("Noodles" with cup/oz/serving measures) therefore outranks a
 * unit-poor one, while a different food never climbs above a same-food
 * record no matter how many units it has.
 */
export function rankUsdaCandidates(
  foods: UsdaFood[],
  entry: FoodLogParserEntry,
  brandTokens: Set<string> = new Set(),
): RankedUsdaCandidate[] {
  const loggedUnit = entry.unit ? normalizedUnitForComparison(entry.unit) : "";
  return foods
    .map(food => {
      // Include brand/restaurant text so "Panda Express Orange Chicken"
      // outranks "Panda puff cereal" instead of losing on description alone.
      const candidateText = [food.description, food.brandOwner, food.brandName].filter(Boolean).join(" ");
      const portions = foodPortionsFromUsda(food);
      const units = new Set<string>();
      for (const portion of portions) {
        for (const unit of portionNormalizedUnits(portion)) units.add(unit);
      }
      return {
        food,
        similarity: entry.new_food_queries.length === 0 ? 0
          : Math.max(...entry.new_food_queries.map(query => keywordSimilarity(query, candidateText))),
        tier: usdaMatchTier(food, entry, brandTokens),
        hasLoggedUnit: Boolean(loggedUnit) && units.has(loggedUnit),
        portionCount: portions.length,
      };
    })
    .sort((left, right) =>
      left.tier - right.tier ||
      Number(right.hasLoggedUnit) - Number(left.hasLoggedUnit) ||
      right.portionCount - left.portionCount ||
      right.similarity - left.similarity,
    );
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
  const entryBrandTokens: Set<string>[] = [];
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

    const pooled = [...foodsById.values()];
    // Brand/restaurant qualifiers ("panda", "express") are pooled from every
    // candidate so a generic same-food record is still recognizable when the
    // branded records sit alongside it in this search.
    const brandTokens = brandTokensFromCandidates(pooled);
    entryBrandTokens.push(brandTokens);
    const ranked = rankUsdaCandidates(pooled, entry, brandTokens).slice(0, MAX_USDA_CANDIDATES);

    candidateOffsets.push(candidates.length);
    let food_queries = entry.new_food_queries.join(", ") ?? "unknown food";
    const loggedAmount = `${entry.quantity ?? 1} ${entry.unit ?? "serving"}`;

    lines.push(`\n[${i}] "${food_queries}" (logged as ${loggedAmount}):`);
    ranked.forEach(({ food, portionCount }, index) => {
      candidates.push(food);
      const portions = foodPortionsFromUsda(food).slice(0, 3)
        .map(portion => `${portionUnit(portion)} (${portion.gramWeight} grams)`);
      const brand = [food.brandOwner, food.brandName].filter(Boolean).join(" / ");
      const label = brand ? `${food.description} [brand: ${brand}]` : food.description;
      const unitNote = portionCount > 3 ? ` (${portionCount} units)` : "";
      lines.push(`${index}. ${label}${portions.length ? `\n   units${unitNote}: ${portions.join(", ")}` : ""}`);
    });
  }

  return { candidates, candidateOffsets, candidateString: lines.join("\n"), entryBrandTokens };
}





export async function resolveAll(entries: readonly FoodLogParserEntry[]): Promise<void> {
  const unresolvedEntries = entries.filter(entry => entry.database_food === null);

  if (unresolvedEntries.length == 0) return;
  const { candidates, candidateOffsets, candidateString, entryBrandTokens } = await findUsdaFoodCandidates(unresolvedEntries);


  const prompt = `Choose the best USDA food candidate for the following food entries:
    ${candidateString}

    Your output must be valid JSON as an object with a single "matches" key holding the array, like this:
    {"matches": [
    {"food_index": number, "candidate_match_index": number | null, "portion": {"gramWeight":number, "unit":string}}, ...
    ]}

RULES:
- RELEVANCE FIRST: only match a candidate that is clearly the same food (same key words, brand, restaurant, or product). Sharing ONE generic word is NOT a match.
  - Example: "panda express" must NEVER match "panda puff cereal" (different brand/product despite sharing "panda"). Return null for it.
  - A generic record of the same food IS acceptable when it is the same dish without the brand (for example "Noodles" for "panda express noodles").
  - If no candidate is the same food, return {"food_index": N, "candidate_match_index": null}. A new food profile is created from that null instead of logging the wrong food. NEVER match a different food just to avoid null.
- Among clearly-relevant candidates, prefer the one with MORE listed units, especially one that already lists the user's logged unit (its gram weight can be copied exactly instead of estimated).
- Include EVERY food_index exactly once, even when the answer is null.
- portions
  - The "portion" describes ONE unit of the food as the user logged it: "gramWeight" is the weight in grams of that single portion, and "unit" is its singular name. For "3 slices", use {"unit": "slice", "gramWeight": <grams in ONE slice>} (never the weight of all 3).
  - USE THE USER'S UNIT shown next to the entry (for example "logged as 13 candies" -> {"unit": "candy"}). It outranks the candidate's own units list.
  - If the candidate's units list already measures the food in the user's unit, copy that unit spelling and gramWeight EXACTLY. If it does not, keep the user's unit in its singular form and estimate a reasonable gramWeight for ONE unit; a new measure is created from it. NEVER substitute "serving" for a unit the user named, even when the candidate only offers "1 serving".
  - Never default to 100 grams when the user gave a specific measure.
  - If the user logged by mass (g, grams, oz, kg, lb...), "unit" is that mass unit and "gramWeight" is exactly one unit's weight (for example "g" -> 1 gram), not 100.
  - If the user gave no unit, prefer a sensible existing portion or "serving".
    `

  console.log("[Food log] USDA candidate prompt:\n", prompt);
  // Object-wrapped output ({"matches": [...]}) is required: forced JSON mode
  // only permits top-level objects, so a bare [...] response never arrives.
  const output = await generateJsonArray(prompt, ["food_index", "candidate_match_index"]);
  console.log(JSON.stringify(output))

  const matchedIndexes = new Set<number>();
  for (const value of output as FoodCandidateMatch[]) {
    if (!Number.isInteger(value.food_index)) continue;
    const foodIndex = value.food_index;
    if (foodIndex < 0 || foodIndex >= unresolvedEntries.length || matchedIndexes.has(foodIndex)) continue;

    // An explicit null (or any non-integer) means "nothing relevant": fall
    // through to the LLM-estimate fallback below instead of forcing a match.
    if (value.candidate_match_index === null || value.candidate_match_index === undefined || !Number.isInteger(value.candidate_match_index)) {
      continue;
    }

    const candidateIndex = candidateOffsets[foodIndex] + (value.candidate_match_index as number);

    if (candidateIndex >= 0 && candidateIndex < candidates.length
    ) {
      console.log(`Candidate: food#=${foodIndex} candidate#=${value.candidate_match_index} portion: ${JSON.stringify(value.portion ?? {})}`)
      const unresolvedEntry = unresolvedEntries[foodIndex];
      const candidate = candidates[candidateIndex];
      if (!unresolvedEntry || !candidate) continue;

      // Code-side relevance gate: the LLM must not log "panda puff cereal"
      // for "panda express". Irrelevant picks fall back to a new profile.
      // Brand tokens pooled from this entry's candidates let a generic
      // same-food record ("Noodles" for "panda express noodles") pass while
      // a different dish ("Chicken soup" for "orange chicken") stays vetoed.
      if (!isRelevantUsdaMatch(candidate, unresolvedEntry, entryBrandTokens[foodIndex] ?? new Set())) {
        console.warn(`[Food log] Rejecting irrelevant USDA candidate "${candidate.description}" for "${unresolvedEntry.new_food_queries[0]}". Falling back to a new food profile.`);
        continue;
      }

      const portions = foodPortionsFromUsda(candidate);
      // The candidate is already in hand, so a measure the person logged but the
      // candidate does not measure can be created from it without another call.
      const selectedPortion = await selectResolvedPortion(
        portions,
        value.portion,
        unresolvedEntry.unit,
        unit => usdaGramsPerUnit(candidate, unit),
      );
      if (selectedPortion) unresolvedEntry.portion = selectedPortion;

      //Add new database food to unresolved entries
      unresolvedEntry.database_food = {
        names: [candidate.description.toLowerCase()],//, ...unresolvedEntry.new_food_queries
        foodNutrients: getUsdaFoodNutrientsPer100g(candidate),
        foodPortions: portions,
        source: "USDA FoodData Central",
        sourceId: String(candidate.fdcId),
      };
      unresolvedEntry.saveFood = true;
      matchedIndexes.add(foodIndex);
    }
  }

  // Anything the matcher left unresolved (null pick, rejected irrelevant pick,
  // or missing row) becomes a brand-new profile: the person's own name (minus
  // an explicit "30 kcal"), their stated calories when present, AI-estimated
  // nutrients otherwise. Shaped like a USDA hit (real portions, saveFood)
  // so logging treats it identically.
  for (let index = 0; index < unresolvedEntries.length; index++) {
    const entry = unresolvedEntries[index];
    if (entry.database_food) continue;
    try {
      const { food, portion } = await createFallbackFood(entry);
      entry.database_food = food;
      entry.portion = portion;
      entry.saveFood = true;
      console.log(`[Food log] Created fallback food "${food.names[0]}" for "${entry.new_food_queries[0]}".`);
    } catch (error) {
      console.warn(`[Food log] Fallback food creation failed for "${entry.new_food_queries[0]}":`, error);
    }
  }
}

