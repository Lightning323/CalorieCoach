import { FoodItem, FoodDatabase } from "./utils/food-database";
import { FoodLog, foodLogToString } from "./utils/account-database";
import { Accounts } from "./utils/account-database";

import { promptGemini, promptGeminiLite } from "./api/geminiApi";
import { OpenFoodFactsApi } from "./api/openFoodFactsApi";

export interface FoodItemAI {
  name: string;
  estimatedCalories: number;
  quantity: string;
  unit?: string;
}

class CoachAIService {

  async getIndividualFoodItems(foodItemsText?: string): Promise<FoodItemAI[]> {
    let prompt =
      `List the following food item(s) in CSV format (name,estimatedCalories,quantity,unit): "${foodItemsText}". Use singular, correct names (e.g., "cup of joe" → "coffee"). Respond with CSV ONLY.`;

    let response = await promptGeminiLite(prompt);
    if (!response) {
      return [];
    }
    response = response.replace(/```csv/i, "").replace(/```/g, "").trim();

    var result: FoodItemAI[] = []
    response.split("\n").forEach((line, i) => {
      var arr = line.split(",")
      result.push({ name: arr[0], estimatedCalories: Number(arr[1]), quantity: arr[2], unit: arr[3] ?? undefined });
    })
    return result;
  }


  async simplePromptPiece(text: string): Promise<{ prompt: string, allMatches: FoodItem[] }> {
    var prompt = `Convert this food description into JSON: \"${text}\":\n`

    //Match all items
    //20 max
    //10% accuracy at least
    const allMatches = await FoodDatabase.searchFoods(text, 20, 0.1, true);

    if (allMatches.length == 0) prompt += "No matches found\n";
    else {
      prompt += allMatches.length + " Possible Matches:\n";
      prompt += "id,\t name,\t quantity,\t calories\n";
      for (var i = 0; i < allMatches.length; i++) {
        prompt += `${i},\t ${allMatches[i].name.replace(/"/g, '\\"').replace(',', ' ')},\t ${allMatches[i].quantity},\t ${allMatches[i].calories}\n`;
      }
    }

    return {
      prompt: prompt,
      allMatches: allMatches
    }
  }


  private getError(err: any) {
    const msg = err?.message ?? "";
    // 🔥 Detect Gemini rate limit
    if (
      msg.includes('"code":429') ||
      msg.includes("429") ||
      msg.includes("quota")
    ) {
      console.warn("Gemini rate limit hit");
      return "AI is temporarily unavailable (rate limit exceeded). Please try again later.";
    }
    console.error(msg);
    return "Error logging food: " + msg;
  }

  async logFood(username: string, foodItemsText: string, simpleMode: boolean): Promise<String> {
    if (!foodItemsText || foodItemsText.trim().length == 0) return "No food items provided."
    try {

      const results: FoodLog[] = [];
      var { prompt, allMatches } = await this.simplePromptPiece(foodItemsText.replace(/"/g, '\\"').toLowerCase())


      prompt += `
Respond with JSON ARRAY ONLY and do your ABSOLUTE BEST to be accurate with calories and quantity.
- If no relevant matches are found, add a new food item instead.
- If the user enters something generic like "260 calories", add a new food item with no name.
- If food is new, omit "match_id" and include "new_food"

format:
[
  {
    "match_id": number,
    "multiplier": number, (2x a 1-cup item = double calories)
  },
  {
    "new_food": {
      "name": string,
      "serving_size": string, (quantity and units. Quantity should be 1 unless units are in grams, ounces, etc.)
      "calories": number
    }
    "multiplier": number
  }
]`;
      console.log("\n\nGemini prompt: \"", prompt, "\"\n");

      try {
        // Call Gemini API
        let response = await promptGemini(prompt);
        if (!response) return "Failed to get Gemini response";
        response = response.replace(/```json/i, "").replace(/```/g, "").trim();


        //Parse JSON from the Gemini response
        let parsed: any[];
        parsed = JSON.parse(response);

        for (const entry of parsed) {
          let foodItem: FoodItem;

          //Get food item
          if (entry.new_food) {
            const nf = entry.new_food;

            var saveFood = true;
            if(!nf.name){
              saveFood = false;
              nf.name = "Unlabeled Food";
            }

            if (nf.calories == null) continue;

            foodItem = {
              name: nf.name ?? "Unknown",
              quantity: nf.serving_size ?? "1 unit",
              calories: nf.calories ?? 0,
              protein: nf.protein ?? 0,
              carbs: nf.carbs ?? 0,
              fat: nf.fat ?? 0,
            };

            if (!(entry.is_unidentified ?? false) && saveFood) {
              await FoodDatabase.addFood(foodItem);
              console.log("Saved new food item:\t" + foodItem.toString());
            }

          } else if (typeof entry.match_id === "number" && entry.match_id >= 0 && allMatches[entry.match_id]) {
            // Existing matched food
            foodItem = allMatches[entry.match_id];
          } else {
            console.warn("Invalid entry from Gemini, skipping:", entry);
            continue;
          }

          // Log the food
          const result = {
            foodItem_id: foodItem._id,
            backup_foodItem: foodItem,
            quantity: entry.multiplier ?? 1,
            notes: entry.notes ?? "",
          }
          results.push(result);
          await Accounts.addFoodLog(username, result);
          console.log("Logged food:\t" + foodLogToString(result));
        }
        return "Successfully logged " + results.length + " items";

      } catch (err) {
        console.log("Error logging food using AI. Resorting to manual algorithm: ", err);
        console.error(err);

        //Use a manual algorithm to log the food
        if (allMatches.length > 0) {
          const result = {
            foodItem_id: allMatches[0]._id,
            backup_foodItem: allMatches[0],
            quantity: 1,
            notes: ""
          }
          results.push(result);
          for (const result of results) {
            await Accounts.addFoodLog(username, result);
          }
          return "Logged " + results.length + " items with errors:\n" + this.getError(err);
        } else {
          return this.getError(err);
        }
      }



    } catch (err: any) {
      return this.getError(err);
    }
  }

}

export const CoachAI = new CoachAIService();