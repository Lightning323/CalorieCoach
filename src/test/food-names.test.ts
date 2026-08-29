import assert from "node:assert/strict";
import test from "node:test";
import {
  FoodDatabaseService,
  FoodItem,
  getFoodNameMatchScore,
  getFoodNames,
  getPrimaryFoodName,
  normalizeFoodNames,
} from "../utils/food-database";

test("normalizes aliases and reads legacy one-name records", () => {
  assert.deepEqual(normalizeFoodNames([
    "  Jamba   Peach  ",
    "jamba peach",
    "Caribbean Passion",
  ]), ["Jamba Peach", "Caribbean Passion"]);
  assert.deepEqual(getFoodNames({ names: [], name: "Legacy banana" }), ["Legacy banana"]);
});

test("uses the strongest matching alias when ranking a food", () => {
  const score = getFoodNameMatchScore("peach jamba", [
    "Caribbean Passion Smoothie",
    "Jamba Peach Smoothie",
  ]);
  const unrelatedScore = getFoodNameMatchScore("peach jamba", ["V8 Peach Mango"]);

  assert.ok(score > unrelatedScore);
  assert.ok(score > 0.8);
});

test("drops unusable aliases and always supplies a display name", () => {
  assert.deepEqual(normalizeFoodNames(["", 12, "   ", "Apple"]), ["Apple"]);
  assert.equal(getPrimaryFoodName({ names: [] }), "Unnamed food");
  assert.equal(getFoodNameMatchScore("", ["Apple"]), 0);
});

test("searches all aliases, ranks the relevant one, and reuses its index", async () => {
  const foods: FoodItem[] = [
    {
      names: ["Peach Jamba", "Jamba Caribbean Passion Peach Smoothie"],
      quantity: "1 serving",
      metrics: { calories: 200 },
    },
    {
      names: ["V8 Peach Mango Smoothie"],
      quantity: "1 serving",
      metrics: { calories: 50 },
    },
  ];
  let reads = 0;
  const database = new FoodDatabaseService() as unknown as {
    collection: () => { find: () => { toArray: () => Promise<FoodItem[]> } };
    searchFoods: (name: string, maxResults?: number) => Promise<FoodItem[]>;
  };
  database.collection = () => ({
    find: () => {
      reads += 1;
      return { toArray: async () => foods };
    },
  });

  const firstSearch = await database.searchFoods("peach jamba");
  const secondSearch = await database.searchFoods("jamba");

  assert.equal(firstSearch[0].names[0], "Peach Jamba");
  assert.deepEqual(secondSearch.map(food => food.names[0]), ["Peach Jamba"]);
  assert.equal(reads, 1);
});
