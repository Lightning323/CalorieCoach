import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveGroqModels } from "../api/llmApi";
import { FoodLoggerAPI } from "../coach-ai/food-log-service";
import { connectDB } from "../db";
import type { FoodLog } from "../utils/account-database";
import { getFoodNames, getFoodPortionName } from "../utils/food-database";
import { scaleLoggedFoodNutrients } from "../utils/logged-food-nutrition";

test("groq defaults to the larger reasoning model with a smaller fallback", () => {
  const { primary, fallback } = resolveGroqModels();
  if (!process.env.GROQ_MODEL) {
    assert.equal(primary, "openai/gpt-oss-120b");
  } else {
    assert.ok(primary.length > 0, "GROQ_MODEL override must be non-empty");
  }
  if (!process.env.GROQ_FALLBACK_MODEL) {
    assert.equal(fallback, "openai/gpt-oss-20b");
  } else {
    assert.ok(fallback.length > 0, "GROQ_FALLBACK_MODEL override must be non-empty");
  }
});

// Live AI eval: runs the full coach pipeline on fixed prompts WITHOUT writing
// anything (parseFoodLog with saveNewFoodEntries=false skips FoodDatabase
// writes and account-log writes). Off by default so the unit suite stays green
// offline; run with RUN_AI_EVAL=1 and valid GROQ/USDA keys plus DB access.
const RUN_LIVE = process.env.RUN_AI_EVAL === "1";

function summarize(input: string, logs: FoodLog[]): string {
  return logs
    .map(log => {
      const food = log.food!;
      const names = getFoodNames(food).join(" | ");
      const portionName = getFoodPortionName(log.portion);
      const grams = Number((log.portion as { gramWeight?: unknown }).gramWeight ?? NaN);
      const scaled = scaleLoggedFoodNutrients(food.foodNutrients, log.quantity, log.portion);
      return `- "${input}" => food=[${names}] source=${food.source ?? "?"} qty=${log.quantity} portion="${portionName}" grams/unit=${grams} scaledKcal=${scaled.calories?.toFixed?.(1) ?? scaled.calories}`;
    })
    .join("\n");
}

async function dryRun(input: string): Promise<FoodLog[]> {
  await connectDB();
  const logs = await new FoodLoggerAPI().parseFoodLog(input, undefined, false);
  console.log(`[AI eval]\n${summarize(input, logs)}`);
  assert.ok(logs.length > 0, `expected at least one resolved food for ${JSON.stringify(input)}`);
  return logs;
}

function liveTest(name: string, run: (t: TestContext) => Promise<void>) {
  test(name, { timeout: 180_000 }, async t => {
    if (!RUN_LIVE) {
      t.skip("Set RUN_AI_EVAL=1 with valid GROQ/USDA keys to run the live AI eval.");
      return;
    }
    await run(t);
  });
}

liveTest("live ai picks a relevant panda express food, not puff cereal", async () => {
  const [log] = await dryRun("panda express orange chicken");
  const names = getFoodNames(log.food!).join(" ").toLowerCase();
  assert.ok(!names.includes("puff") && !names.includes("cereal"), `irrelevant pick: ${names}`);
  assert.ok(
    names.includes("panda") || (names.includes("orange") && names.includes("chicken")),
    `expected panda express / orange chicken, got: ${names}`,
  );
});

liveTest("live ai accepts generic noodles for panda express noodles", async () => {
  const [log] = await dryRun("2 cups of panda express noodles");
  const names = getFoodNames(log.food!).join(" ").toLowerCase();
  assert.ok(!names.includes("puff") && !names.includes("cereal"), `irrelevant pick: ${names}`);
  assert.ok(names.includes("noodle"), `expected a noodle food, got: ${names}`);
  assert.equal(log.quantity, 2);
});

liveTest("live ai resolves 150 g of chicken breast to 150 grams total", async () => {
  const [log] = await dryRun("150 g of chicken breast");
  const gramsPerUnit = Number((log.portion as { gramWeight?: unknown }).gramWeight);
  const totalGrams = log.quantity * gramsPerUnit;
  assert.ok(
    Math.abs(totalGrams - 150) / 150 <= 0.05,
    `expected ~150 g total (qty=${log.quantity}, g/unit=${gramsPerUnit}), got ${totalGrams}`,
  );
});

liveTest("live ai converts 2 oz of cheddar cheese to ~56.7 grams", async () => {
  const [log] = await dryRun("2 oz of cheddar cheese");
  const gramsPerUnit = Number((log.portion as { gramWeight?: unknown }).gramWeight);
  const totalGrams = log.quantity * gramsPerUnit;
  assert.ok(
    Math.abs(totalGrams - 56.7) / 56.7 <= 0.1,
    `expected ~56.7 g total (qty=${log.quantity}, g/unit=${gramsPerUnit}), got ${totalGrams}`,
  );
});

liveTest("live ai keeps 3 slices of pizza as a 3-count slice portion", async () => {
  const [log] = await dryRun("3 slices of pizza");
  assert.equal(log.quantity, 3);
  const portionName = getFoodPortionName(log.portion).toLowerCase();
  assert.ok(portionName.includes("slice"), `expected a slice portion, got "${portionName}"`);
});

liveTest("live ai creates azxyz bar with the stated 30 kcal", async () => {
  const [log] = await dryRun("azxyz bar, 30 kcal");
  const scaled = scaleLoggedFoodNutrients(log.food!.foodNutrients, log.quantity, log.portion);
  assert.ok(
    Math.abs(Number(scaled.calories) - 30) / 30 <= 0.15,
    `expected ~30 kcal total, got ${scaled.calories}`,
  );
});

liveTest("live ai handles a bare 20 calories entry", async () => {
  const [log] = await dryRun("20 calories");
  const scaled = scaleLoggedFoodNutrients(log.food!.foodNutrients, log.quantity, log.portion);
  assert.ok(
    Math.abs(Number(scaled.calories) - 20) / 20 <= 0.25,
    `expected ~20 kcal total, got ${scaled.calories}`,
  );
});
