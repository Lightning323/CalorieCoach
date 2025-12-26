
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

 const prompt = await   CoachAI.simplePromptPiece("oreo",);//, 3 corn on the cob, 10 tomatoes, and 2 cups of orange juice

    console.log("prompt\n",prompt.prompt);
    console.log(prompt.allMatches);
}

main();