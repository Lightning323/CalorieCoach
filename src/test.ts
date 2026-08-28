
import { getUsdaMetricsPer100g, UsdaFoodDataApi } from "./api/usdaFoodDataApi";

async function main() {
  const search = await UsdaFoodDataApi.searchFoods("pancake", {
    dataType: ["SR Legacy", "Foundation"],
    pageSize: 1,
    sortBy: "fdcId",
    sortOrder: "desc",
  });
  const fdcId = search.foods[0]?.fdcId;
  if (!fdcId) throw new Error("USDA search returned no foods to verify.");

  const [food, listedFoods, foods] = await Promise.all([
    UsdaFoodDataApi.getFoodById(fdcId),
    UsdaFoodDataApi.listFoods({ pageSize: 1 }),
    UsdaFoodDataApi.getFoodsByIds([fdcId]),
  ]);

  if (food.fdcId !== fdcId) throw new Error("USDA detail response did not match the requested food.");
  if (!foods.some(item => item.fdcId === fdcId)) throw new Error("USDA multi-food response omitted the requested food.");
  if (!Array.isArray(listedFoods)) throw new Error("USDA list response was not an array.");

  const metrics = getUsdaMetricsPer100g(food);
  if (["calories", "protein", "carbs", "fat"].some(metric => !Number.isFinite(metrics[metric]))) {
    throw new Error("USDA detail response did not provide valid per-100 g core metrics.");
  }
  if (Object.keys(metrics).every(metric => ["calories", "protein", "carbs", "fat"].includes(metric))) {
    throw new Error("USDA detail response did not provide any configured micronutrients.");
  }

  console.log(`USDA API verified with FDC ID ${fdcId}: ${food.description}`, metrics);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
