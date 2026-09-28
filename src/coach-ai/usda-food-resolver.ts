import {
  getUsdaFoodNutrientsPer100g,
  UsdaFood,
  UsdaFoodDataApi,
  UsdaFoodPortion,
} from "../api/usdaFoodDataApi";
import { FoodItem, FoodPortion, getFoodPortions, getFoodPortionName } from "../utils/food-database";
import { keywordSimilarity } from "../utils/utils";
import { FoodLLM, FoodLogParserEntry } from "./food-log-llm";
import { readPortionUnit, readPositiveNumber } from "./types";
import {
  normalizeFoodUnit,
  resolveUsdaFoodPortion,
  usdaFoodIdFromStoredFood,
  usdaGramsPerUnit,
} from "../services/food-portion-service";
import { generateJson } from "../api/llmApi";
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
 * Returns a portion of one fixed mass unit (for example "1 g" or "1 oz").
 * Reuses an existing measure when available; otherwise appends a new one so
 * a mass-based log ("150 g of chicken") scales by its real weight instead of
 * collapsing onto the top (often 100 g) portion.
 */
function massPortionForUnit(portions: FoodPortion[], unit: string): FoodPortion | undefined {
  const normalized = normalizedUnitForComparison(unit);
  const gramsPerUnit = MASS_GRAMS_PER_UNIT[normalized];
  if (gramsPerUnit === undefined) return undefined;

  const existing = findMatchingExistingPortion(portions, normalized, gramsPerUnit);
  if (existing) return existing;

  const created: FoodPortion = {
    amount: 1,
    measureUnit: { name: normalized },
    gramWeight: gramsPerUnit,
    rank: Math.max(0, ...portions.map(portion => portion.rank ?? 0)) + 1,
  };
  portions.push(created);
  return created;
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

/** Appends a one-unit measure to a food's list. Mutates `portions`. */
function createPortion(portions: FoodPortion[], unit: string, gramWeight: number): FoodPortion {
  const created: FoodPortion = {
    amount: 1,
    measureUnit: { name: unit },
    gramWeight,
    rank: Math.max(0, ...portions.map(portion => portion.rank ?? 0)) + 1,
  };
  portions.push(created);
  return created;
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
    let food_queries = entry.new_food_queries.join(", ") ?? "unknown food";
    const loggedAmount = `${entry.quantity ?? 1} ${entry.unit ?? "serving"}`;

    lines.push(`\n[${i}] "${food_queries}" (logged as ${loggedAmount}):`);
    ranked.forEach(({ food }, index) => {
      candidates.push(food);
      const portions = foodPortionsFromUsda(food).slice(0, 3)
        .map(portion => `${portionUnit(portion)} (${portion.gramWeight} grams)`);
      lines.push(`${index}. ${food.description}${portions.length ? `\n   units: ${portions.join(", ")}` : ""}`);
    });
  }

  return { candidates, candidateOffsets, candidateString: lines.join("\n") };
}





export async function resolveAll(entries: readonly FoodLogParserEntry[]): Promise<void> {
  const unresolvedEntries = entries.filter(entry => entry.database_food === null);

  if (unresolvedEntries.length == 0) return;
  const { candidates, candidateOffsets, candidateString } = await findUsdaFoodCandidates(unresolvedEntries);


  const prompt = `Choose the best USDA food candidate for the following food entries: 
    ${candidateString}
    
    Your output must be valid JSON and look like this:
    [
    {"food_index": number, "candidate_match_index": number, "portion": {"gramWeight":number, "unit":string}}, ...
    ]

RULES:
- portions
  - The "portion" describes ONE unit of the food as the user logged it: "gramWeight" is the weight in grams of that single portion, and "unit" is its singular name. For "3 slices", use {"unit": "slice", "gramWeight": <grams in ONE slice>} (never the weight of all 3).
  - USE THE USER'S UNIT shown next to the entry (for example "logged as 13 candies" -> {"unit": "candy"}). It outranks the candidate's own units list.
  - If the candidate's units list already measures the food in the user's unit, copy that unit spelling and gramWeight EXACTLY. If it does not, keep the user's unit in its singular form and estimate a reasonable gramWeight for ONE unit; a new measure is created from it. NEVER substitute "serving" for a unit the user named, even when the candidate only offers "1 serving".
  - Never default to 100 grams when the user gave a specific measure.
  - If the user logged by mass (g, grams, oz, kg, lb...), "unit" is that mass unit and "gramWeight" is exactly one unit's weight (for example "g" -> 1 gram), not 100.
  - If the user gave no unit, prefer a sensible existing portion or "serving".
    `

  console.log("[Food log] USDA candidate prompt:\n", prompt);
  const output = await generateJson(prompt);
  console.log(JSON.stringify(output))

  if (!Array.isArray(output)) throw new Error("USDA matcher response was not a list.");

  for (const value of output as FoodCandidateMatch[]) {
    if (!Number.isInteger(value.food_index) || !Number.isInteger(value.candidate_match_index)) continue;

    const foodIndex = value.food_index
    const candidateIndex = candidateOffsets[value.food_index] + value.candidate_match_index;

    if (foodIndex >= 0 && foodIndex < unresolvedEntries.length &&
      candidateIndex >= 0 && candidateIndex < candidates.length
    ) {
      console.log(`Candidate: food#=${foodIndex} candidate#=${value.candidate_match_index} portion: ${JSON.stringify(value.portion??{})}`)
      const unresolvedEntry = unresolvedEntries[foodIndex];
      const candidate = candidates[candidateIndex];
      if (!unresolvedEntry || !candidate) continue;

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
      unresolvedEntry.saveFood = true
    }
  }
}

