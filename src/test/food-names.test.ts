import assert from "node:assert/strict";
import test from "node:test";
import {
  getFoodNames,
  getPrimaryFoodName,
  normalizeFoodNames,
} from "../utils/food-database";

test("normalizes aliases and reads modern multi-name records", () => {
  assert.deepEqual(normalizeFoodNames([
    "  Jamba   Peach  ",
    "jamba peach",
    "Caribbean Passion",
  ]), ["Jamba Peach", "Caribbean Passion"]);
  assert.deepEqual(getFoodNames({ names: ["Modern banana"] }), ["Modern banana"]);
});

test("drops unusable aliases and always supplies a display name", () => {
  assert.deepEqual(normalizeFoodNames(["", 12, "   ", "Apple"]), ["Apple"]);
  assert.equal(getPrimaryFoodName({ names: [] }), "Unnamed food");
});
