import { FoodLoggerAPI } from "./coach-ai/food-log-service";
import { connectDB } from "./db";

async function main() {
  await connectDB();
    // console.log( await generate("Hi there"))
  // let parser = new FoodLLM();
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
    "brisket, 3 heaping teaspoons, and 3 slices of pastrami bread",
    (progress: { progress: number; message: string }) => {
    },
    false
  );

  // parseIntoFoodEntries("10 ritz crackers, 20 sun chips\n3 slices baked alaska, 3 doritos, cool ranch and 1 pbh, 1 candy, 3 slices of pizza, lime fruit strip")
  // ;

  // console.log("Food log result:", result);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
