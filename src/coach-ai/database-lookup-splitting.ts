import { generateJson } from "../api/llmApi";
import { keywordSimilarity } from "../utils/utils";
import {
    FoodDatabase,
    FoodItem,
    getFoodNames,
} from "../utils/food-database";
import type { FoodLogParserEntry } from "./food-log-llm";
import { UsdaFoodPortion } from "../api/usdaFoodDataApi";




async function getDatabaseFoodCandidates(
    text: string,
    verbose: boolean = false
): Promise<{ databaseFoodCandidateString: string; foodList: FoodItem[] }> {
    const foods = await FoodDatabase.getAllFoods();

    const cleanForSearch = (value: string): string => {
        return value
            .trim()
            .replace(
                /^\d+(?:\.\d+)?\s*(?:(?:x|pieces?|slices?|servings?)\s*)?(?:of\s+)?/i,
                ""
            )
            .trim();
    };

    const getBestMatch = (query: string) => {
        let bestFood: FoodItem | null = null;
        let bestSimilarity = 0;

        foods.forEach((food) => {
            getFoodNames(food).forEach((alias) => {
                const similarity = keywordSimilarity(query, alias);

                if (similarity > bestSimilarity) {
                    bestFood = food;
                    bestSimilarity = similarity;
                }
            });
        });

        return { food: bestFood, similarity: bestSimilarity };
    };

    const chunks: string[] = [];

    text.split(/[,;\n]+|\b(?:and|plus)\b/gi).forEach((chunk) => {
        const trimmedChunk = chunk.trim();

        if (trimmedChunk) {
            chunks.push(trimmedChunk);
        }
    });

    // Merge adjacent comma-separated chunks only when the combined phrase
    // matches the database substantially better.
    const foodEntries: string[] = [];

    for (let index = 0; index < chunks.length; index++) {
        const currentChunk = chunks[index];
        const nextChunk = chunks[index + 1];

        const currentMatch = getBestMatch(cleanForSearch(currentChunk));

        if (nextChunk) {
            const combinedChunk = `${currentChunk} ${nextChunk}`;
            const combinedMatch = getBestMatch(cleanForSearch(combinedChunk));

            if (
                combinedMatch.similarity >= 0.5 &&
                combinedMatch.similarity > currentMatch.similarity + 0.15
            ) {
                foodEntries.push(combinedChunk);
                index++;
                continue;
            }
        }

        foodEntries.push(currentChunk);
    }

    const foodList: FoodItem[] = [];
    const output: string[] = [];

    foodEntries.forEach((textChunk) => {
        const searchText = cleanForSearch(textChunk);
        const candidates: { food: FoodItem; similarity: number }[] = [];

        foods.forEach((food) => {
            let bestSimilarity = 0;

            getFoodNames(food).forEach((alias) => {
                const similarity = keywordSimilarity(searchText, alias);

                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                }
            });

            if (bestSimilarity >= 0.51) {
                candidates.push({
                    food,
                    similarity: bestSimilarity,
                });
            }
        });

        candidates.sort((a, b) => b.similarity - a.similarity);
        const topCandidates = candidates.slice(0, 5); //No more than N candidates for each chunk

        // Do not include chunks that have no candidates.
        if (topCandidates.length === 0) {
            return;
        }

        let candidateString = `Text chunk: ${textChunk}\n`;

        topCandidates.forEach(({ food, similarity }) => {
            foodList.push(food);
            candidateString += `${foodList.length - 1}. "${getFoodNames(food).join(", ")}"`;
            candidateString += "\n  units: "
            const portions = food.foodPortions;
            for (const p of portions) {
                candidateString += `  ${p.measureUnit?.name ??
                    p.measureUnit?.abbreviation ??
                    p.portionDescription ??
                    "serving"
                    } (${p.gramWeight} grams), `;
            }
            if (verbose) {
                candidateString += ` (similarity: ${similarity.toFixed(2)})`;
            }

            candidateString += "\n";
        });

        output.push(candidateString.trim());
    });

    const databaseFoodCandidateString = output.join("\n\n");
    return { databaseFoodCandidateString, foodList };
}

export async function parseIntoFoodEntries(text: string): Promise<FoodLogParserEntry[]> {

    const { databaseFoodCandidateString, foodList } = await getDatabaseFoodCandidates(text, false);

    const prompt = `
Parse this food log into individual food entries: ${JSON.stringify(text)}

Database candidates:
${databaseFoodCandidateString}

Return only a valid JSON array. No Markdown or explanation. Each array item must be exactly one of these shapes:

{"database_food_index": number, "quantity": number, "portion": {"unit": {"measureUnit": string}, "gramWeight": number}}
{"new_food_queries": [string], "quantity": number}

Database-match rules:
- Always use "database_food_index" when the food matches one of the numbered database candidates.
- The index must exactly match a candidate number from the database candidates list.
- If no candidate is clearly correct, use "new_food_queries" instead.

New-food rules:
- "new_food_queries" must contain 3–10 aliases for the same food.
- The first value is the exact food description without quantity or unit.
- Preserve brands, restaurants, flavors, products, and abbreviations exactly. Example: "PBH" stays "PBH"; "peach Jamba" retains "Jamba".
- Later values may be more general aliases, but must still describe the exact same food.
- Do not include unrelated or overly generic aliases.

Quantity and unit rules:
- Extract only the quantity and unit explicitly stated by the user.
- Use singular units: "20 SunChips" → quantity 20, unit "chip"; "3 slices of pizza" → quantity 3, unit "slice".
- A countable food is its own unit: "1 candy" → unit "candy".
- If no quantity is stated, use quantity 1.
- If no measure or count noun is stated, use unit "serving".
- Do not infer servings, grams, calories, or nutrition values.

Parsing rules:
- Include every food the user listed.
- Keep flavors and descriptors with their food: "Doritos, Cool Ranch" is one food item.
- Split actual components into separate items when appropriate.
- Do not output nutrition data or fields beyond the allowed shapes.
`;

    console.log(`Food parser prompt:\n${prompt}`);
    const parsed = await generateJson(prompt);
    if (!Array.isArray(parsed)) throw new Error("Food parser response was not a list.");

    for (const entry of parsed as FoodLogParserEntry[]) {
        if (
            "database_food_index" in entry &&
            typeof entry.database_food_index === "number"
        ) {
            entry.database_food = foodList[entry.database_food_index - 1] ?? null;
            entry.new_food_queries = getFoodNames(entry.database_food);
            delete entry.database_food_index;
        } else {
            entry.database_food = null;
        }
    }

    if (parsed.length === 0) throw new Error("Food parser did not find any food items.");
    let foodParsed = parsed as FoodLogParserEntry[];
    // console.log(`Food parser: ${JSON.stringify(foodParsed, null, 2)}`);
    return foodParsed;
}
