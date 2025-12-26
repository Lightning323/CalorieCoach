"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoachAI = void 0;
const food_database_1 = require("./utils/food-database");
const account_database_1 = require("./utils/account-database");
const geminiApi_1 = require("./geminiApi");
const account_database_2 = require("./utils/account-database");
class CoachAIService {
    async logFood(username, foodItemsText) {
        try {
            if (!foodItemsText || foodItemsText.trim() === "" || foodItemsText === undefined || foodItemsText === null) {
                return "No food description provided";
            }
            foodItemsText = foodItemsText.trim();
            let prompt = `A user has submitted some food items to be logged:\n"${foodItemsText}"\n`;
            // Search DB for existing matches
            const matches = await food_database_1.Foods.searchFoods(foodItemsText);
            if (matches.length > 0) {
                prompt += `\nFound ${matches.length} potential matching food items:\n`;
                matches.forEach((match, i) => {
                    prompt += `#${i}) ${match.item.name} (quantity=${match.item.quantity}; calories=${match.item.calories})\n`;
                });
            }
            else {
                prompt += `No potential matching food items were found, so you will have to create new entries.\n`;
            }
            prompt += `
Please respond with JSON ONLY. If no similar foods exist, create new entries.
The quantity tells us the multiplier for the food item, For instance a quantity of 2 for a 1 cup food item amounts to 2 cups and doubles the calories.
The notes field is optional and can be used to describe why the food item was added.
If this is a new food entry, skip "match_id" and instead add "new_food" element instead.
[
  {
    "notes": "Closest match in DB",
    "quantity: 2,
    "match_id": 0,
  },
  {
    "notes": "This is a New food entry, calories estimated based on the fat content in the food",
    "quantity: 1,
    "save": true, (If the users entry is too vauage, like "260 calories", set "save" to false)
    "new_food": {
            name: string;
            quantity?: string; (the quantity should be 1 but you get to decide the units)
            calories: number;
            protein?: number;
            carbs?: number;
            fat?: number;
      }
  }
]`;
            // Call Gemini API
            let response;
            try {
                response = await (0, geminiApi_1.promptGemini)(prompt);
            }
            catch (err) {
                console.error("Gemini API error:", err);
                return "Gemini API failed:" + err;
            }
            if (!response)
                return "Failed to get Gemini response";
            else {
                console.log("Gemini response:\n", response);
            }
            // Strip ```json ``` if present
            response = response.replace(/```json/i, "").replace(/```/g, "").trim();
            //Parse JSON from the Gemini response
            let parsed;
            try {
                parsed = JSON.parse(response);
            }
            catch (err) {
                return "Failed to parse Gemini response:" + err + "\nRaw response:" + response;
            }
            const results = [];
            for (const entry of parsed) {
                if (!entry.quantity)
                    continue;
                let foodItem;
                // New food entry
                if (entry.new_food) {
                    const nf = entry.new_food;
                    if (!nf.name || nf.calories == null)
                        continue;
                    foodItem = {
                        name: nf.name,
                        quantity: nf.quantity ?? "1 unit",
                        calories: nf.calories,
                        protein: nf.protein ?? 0,
                        carbs: nf.carbs ?? 0,
                        fat: nf.fat ?? 0,
                    };
                    if (entry.save ?? true) {
                        await food_database_1.Foods.addFood(foodItem);
                        console.log("Saved new food item:\t" + foodItem.toString());
                    }
                }
                else if (typeof entry.match_id === "number" && entry.match_id >= 0 && matches[entry.match_id]) {
                    // Existing matched food
                    foodItem = matches[entry.match_id].item;
                }
                else {
                    console.warn("Invalid entry from Gemini, skipping:", entry);
                    continue;
                }
                const result = {
                    foodItem_id: foodItem._id,
                    backup_foodItem: foodItem,
                    quantity: entry.quantity,
                    notes: entry.notes ?? "",
                    logDate: new Date(),
                };
                results.push(result);
                await account_database_2.Accounts.addFoodLog(username, result);
                console.log("Logged food:\t" + (0, account_database_1.foodLogToString)(result));
            }
            return "Successfully logged " + results.length + " items";
        }
        catch (err) {
            console.error(err);
            return "Failed to log food:" + err;
        }
    }
}
exports.CoachAI = new CoachAIService();
