import assert from "node:assert/strict";
import test from "node:test";
import { FoodLLM, FoodLogParserEntry } from "../coach-ai/food-log-llm";
import { FoodLogResolver } from "../coach-ai/food-resolver";
import { FoodLoggerAPI } from "../coach-ai/food-log-service";
import { ResolvedFoodLog } from "../coach-ai/types";

const parsedEntries: FoodLogParserEntry[] = [
  { food_queries: ["first food"], quantity: 1, unit: "serving" },
  { food_queries: ["second food"], quantity: 1, unit: "serving" },
];

function resolvedFood(name: string): ResolvedFoodLog {
  return {
    food: {
      names: [name],
      quantity: "1 serving",
      metrics: { calories: 100, protein: 0, carbs: 0, fat: 0 },
    },
    quantity: 1,
    saveFood: true,
  };
}

test("resolves parsed food entries concurrently while preserving their order", async () => {
  const started: string[] = [];
  let allResolversStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>(resolve => { allResolversStarted = resolve; });
  let releaseResolvers: (() => void) | undefined;
  const release = new Promise<void>(resolve => { releaseResolvers = resolve; });

  const parser = {
    async parseIntoFoodEntries(): Promise<FoodLogParserEntry[]> {
      return parsedEntries;
    },
  } as unknown as FoodLLM;
  const resolver = {
    async resolve(entry: FoodLogParserEntry): Promise<ResolvedFoodLog> {
      started.push(entry.food_queries[0]);
      if (started.length === parsedEntries.length) allResolversStarted?.();
      await release;
      return resolvedFood(entry.food_queries[0]);
    },
  } as FoodLogResolver;
  const logger = new FoodLoggerAPI(parser, resolver);

  const resolution = logger.parseFoodLog("first food and second food", undefined, false);
  await bothStarted;
  assert.deepEqual(started, ["first food", "second food"]);

  releaseResolvers?.();
  const resolved = await resolution;
  assert.deepEqual(resolved.map(entry => entry.food.names[0]), ["first food", "second food"]);
});
