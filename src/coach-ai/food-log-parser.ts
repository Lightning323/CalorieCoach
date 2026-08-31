import { promptGeminiLite } from "../api/geminiApi";
import { FoodLogLogger } from "./food-log-logger";
import { FoodLogParserEntry } from "./types";

const FOOD_LOG_GENERATION_CONFIG = {
  responseMimeType: "application/json",
  temperature: 0,
  maxOutputTokens: 1024,
};

function buildFoodParserPrompt(text: string): string {
  return `Parse this food log into individual food entries: ${JSON.stringify(text)}

Return a JSON array only. Every described food must have this shape:
{"food_query": string, "quantity": number, "unit": string}

Rules:
- food_query is only the exact food, brand, restaurant, product, and flavor description. Do not include an amount or measure in it. Preserve abbreviations exactly: for example, "PBH" stays "PBH".
- Preserve every brand, restaurant, product, and flavor qualifier. For example, "peach Jamba" must retain "Jamba". Never replace a branded or restaurant item with a different brand or a generic product.
- Preserve the amount and measure the person described. For example, "2 slices of pizza" becomes {"food_query":"pizza","quantity":2,"unit":"slice"}; "1 candy" becomes {"food_query":"candy","quantity":1,"unit":"candy"}; and "150 g chicken" becomes {"food_query":"chicken","quantity":150,"unit":"g"}. If no amount is stated, use quantity 1 and unit "serving".
- Include every component separately. Never combine ingredients into a meal entry.
- Do not provide or infer calories, protein, carbohydrates, fat, serving nutrition, or any other nutrition values. You are only a text-and-portion parser.
- Do not include markdown, prose, or fields other than the allowed shape.`;
}

export class FoodLogParser {
  async parseIntoFoodEntries(text: string, logger: FoodLogLogger): Promise<FoodLogParserEntry[]> {
    const prompt = buildFoodParserPrompt(text);
    // logger.debug("Built food parser prompt.", { prompt });
    const response = await promptGeminiLite(prompt, FOOD_LOG_GENERATION_CONFIG);
    if (!response) throw new Error("Failed to get a food parser response.");

    // logger.debug("Received raw food parser response.", { response });
    const parsed: unknown = JSON.parse(response);
    if (!Array.isArray(parsed)) throw new Error("Food parser response was not a list.");
    if (parsed.length === 0) throw new Error("Food parser did not find any food items.");

    return parsed as FoodLogParserEntry[];
  }
}
