import assert from "node:assert/strict";
import test from "node:test";
import { foodNameMigrationRequired, migrateFoodNames } from "../migrations/food-name-migration";

test("migrates the singular name into the required names array", () => {
  const legacyFood = { name: "  Jamba   Peach  " };

  assert.deepEqual(migrateFoodNames(legacyFood), ["Jamba Peach"]);
  assert.equal(foodNameMigrationRequired(legacyFood), true);
});

test("preserves existing aliases and appends a distinct former name", () => {
  const food = {
    names: ["Jamba Peach", "Caribbean Passion"],
    name: "Jamba Caribbean Passion Smoothie",
  };

  assert.deepEqual(migrateFoodNames(food), [
    "Jamba Peach",
    "Caribbean Passion",
    "Jamba Caribbean Passion Smoothie",
  ]);
});

test("leaves an already canonical food unchanged and rejects nameless data", () => {
  assert.equal(foodNameMigrationRequired({ names: ["Peach"] }), false);
  assert.throws(() => migrateFoodNames({ names: [], name: "  " }), /no usable name/);
});
