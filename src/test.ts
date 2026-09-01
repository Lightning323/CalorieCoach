import { FoodLoggerAPI } from "./coach-ai/food-log-service";
import { connectDB } from "./db";
async function main() {

  // let result = await generate("Hello, world!");
  // console.log("LLM response:", result);
 await connectDB(); // 🔥 REQUIRED

  // let parser = new FoodLogParser();
  // console.log("Food parser:", await parser.parseIntoFoodEntries("1 lime fruit strip"));
  // console.log("Food parser:", await parser.generateAliases("fruit strip"));

  let logger = new FoodLoggerAPI();
  const result = await logger.parseFoodLog(
    "3 pancakes, 1 cup of coffee with milk and sugar, and 2 slices of bacon",
    (progress: { progress: number; message: string }) => {
      // console.log(`Progress: ${progress.progress}% - ${progress.message}`);
    },
    false
  );

  // console.log("Food log result:", result);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
