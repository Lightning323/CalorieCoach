import { CoachAI } from "./coachAI";
import { connectDB } from "./db";
import {generate} from "./api/llmApi";
import { FoodLogParser } from "./coach-ai/food-log-parser";
async function main() {

  // let result = await generate("Hello, world!");
  // console.log("LLM response:", result);
 await connectDB(); // 🔥 REQUIRED

  // let parser = new FoodLogParser();
  // console.log("Food parser:", await parser.parseIntoFoodEntries("1 lime fruit strip"));
  // console.log("Food parser:", await parser.generateAliases("fruit strip"));


  const result = await CoachAI.logFood(
    "testuser",
    "1 lime fruit strip",
    (progress: { progress: number; message: string }) => {
      // console.log(`Progress: ${progress.progress}% - ${progress.message}`);
    },
  );

  // console.log("Food log result:", result);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
