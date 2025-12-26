
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

 const prompt = await   CoachAI.promptPiece("test",[
        {name: "bar", quantity: "2", estimatedCalories: 200},
        {name: "banana", quantity: "2", estimatedCalories: 200},
        {name: "coffee", quantity: "2", unit: "cup", estimatedCalories: 200},
        {name: "string bean", quantity: "2", estimatedCalories: 200},
        {name: "raspberry", quantity: "2", estimatedCalories: 200},
    ]);

    console.log("prompt\n",prompt.prompt);
    console.log(prompt.allMatches);
}

main();