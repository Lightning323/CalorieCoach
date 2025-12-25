import { Foods, FoodItem, FoodDatabase } from "./utils/food-database";
import { FoodLog,foodLogToString } from "./utils/account-database";
import { promptGemini } from "./geminiApi";

class CoachAIService {
 async logFood(foodItemsText?: string): Promise<FoodLog[]> {

  if (!foodItemsText || foodItemsText.trim() === "" || foodItemsText === undefined || foodItemsText === null) {
    console.log("No food description provided");
    return [];
  }

  foodItemsText = foodItemsText.trim();

  let prompt = `A user has submitted some food items to be logged:\n"${foodItemsText}"\n`;

  // Search DB for existing matches
  const matches = await Foods.searchFoods(foodItemsText);

  if (matches.length > 0) {
    prompt += `\nFound ${matches.length} potential matching food items:\n`;
    matches.forEach((match, i) => {
      prompt += `#${i}) ${match.item.name} (quantity=${match.item.quantity}; calories=${match.item.calories})\n`;
    });
  } else {
    prompt += `No potential matching food items were found, so you will have to create new entries.\n`;
  }

  prompt += `
Please respond with JSON ONLY. If no similar foods exist, create new entries.
Use "match_id" = -1 for new foods. Example:
[
  {
    "notes": "Closest match in DB",
    "name": "Apple",
    "match_id": 0,
    "quantity": 1,
    "calories": 100
  },
  {
    "notes": "New food entry, calories estimated",
    "name": "Banana",
    "match_id": -1,
    "quantity": 2,
    "calories": 150
  }
]`;

  // Call Gemini API
  let response: string | undefined;
  try {
    response = await promptGemini(prompt);
  } catch (err) {
    console.error("Gemini API failed:", err);
    return [];
  }

  if (!response) return [];

  // Strip ```json ``` if present
  response = response.replace(/```json/i, "").replace(/```/g, "").trim();

  let parsed: any[];
  try {
    parsed = JSON.parse(response);
  } catch (err) {
    console.error("Failed to parse Gemini response:", err, "\nRaw response:", response);
    return [];
  }

  const results: FoodLog[] = [];

  for (const entry of parsed) {
    if (!entry.name || entry.quantity == null || entry.calories == null) continue;

    let foodItem: FoodItem;

    if (entry.match_id === -1) {
      // New food — create in DB
      foodItem = await Foods.addFood({
        name: entry.name,
        quantity: entry.quantity,
        calories: entry.calories,
      });
    } else if (matches[entry.match_id]) {
      // Existing matched food
      foodItem = matches[entry.match_id].item;
    } else {
      // Fallback: treat as new
      foodItem = await Foods.addFood({
        name: entry.name,
        quantity: entry.quantity,
        calories: entry.calories,
      });
    }

    results.push({
      foodItem,
      quantity: entry.quantity,
      notes: entry.notes ?? "",
      logDate: new Date(),
    });
  }
  return results;
}

}

export const CoachAI = new CoachAIService();
