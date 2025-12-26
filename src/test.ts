
import { OpenFoodFactsApi } from "./api/openFoodFactsApi";
import { connectDB } from "./db";
import { FoodDatabase } from "./utils/food-database";
import { CoachAI } from "./coachAI";


async function main() {
  await  connectDB();

    // const results1 = await FoodDatabase.getFoodMatches(["apple", "banana", "coffee", "string bean", "raspberry"]);
    // console.log(results1);

    // const result = await OpenFoodFactsApi.getAPIFoodMatches(["apple", "banana", "coffee", "string bean", "raspberry"]);
    // console.log(result);

 const prompt = await   CoachAI.promptPiece([
        {name: "bar", quantity: "2"},
        {name: "banana", quantity: "2"},
        {name: "coffee", quantity: "2", unit: "cup"},
        {name: "string bean", quantity: "2"},
        {name: "raspberry", quantity: "2"},
    ]);

    console.log("prompt\n",prompt.prompt);
    console.log(prompt.allMatches);
}

main();