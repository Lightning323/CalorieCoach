import assert from "node:assert/strict";
import test from "node:test";
import { getFoodNameMatchScore, getFoodNames, normalizeFoodNames } from "./utils/food-database";

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
