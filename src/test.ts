import { FoodLoggerAPI } from "./coach-ai/food-log-service";
import { connectDB } from "./db";
import { FoodLLM } from "./coach-ai/food-log-llm";
async function main() {

  // let result = await generate("Hello, world!");
  // console.log("LLM response:", result);
  await connectDB(); // 🔥 REQUIRED

  let parser = new FoodLLM();
  // console.log("Food parser:", await parser.parseIntoFoodEntries("1 lime fruit strip"));
  // console.log("Food parser:", await parser.generateAliases("fruit strip"));

  // const candidateIndex = await parser.selectBestFoodCandidate(
  //   {
  //     "food_queries": ["fruit strip"],
  //     "quantity": 1,
  //     "unit": "lime",
  //   },
  //   [
  //     {
  //       name: "nachos",
  //     },
  //     {
  //       name: "fruit roll up",
  //     },
  //     {
  //       name: "fruit strip",
  //       aliases: ["fruit strip", "fruit strips"],
  //     }
  //   ]
  // );
  // console.log("Candidate index:", candidateIndex);

  let logger = new FoodLoggerAPI();
  const result = await logger.parseFoodLog(
    "20 flubber",
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
