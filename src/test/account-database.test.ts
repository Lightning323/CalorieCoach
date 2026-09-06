import assert from "node:assert/strict";
import test from "node:test";
import {
  foodLogDateKey,
  isFoodLogDateKey,
} from "../utils/food-log-dates";

test("uses real account-local calendar dates as food-log map keys", () => {
  const instant = new Date("2026-09-06T05:30:00.000Z");

  assert.equal(foodLogDateKey(instant, "America/Denver"), "2026-09-05");
  assert.equal(foodLogDateKey(instant, "UTC"), "2026-09-06");
});

test("accepts only real food-log date keys", () => {
  assert.equal(isFoodLogDateKey("2026-02-28"), true);
  assert.equal(isFoodLogDateKey("2024-02-29"), true);
  assert.equal(isFoodLogDateKey("2026-02-29"), false);
  assert.equal(isFoodLogDateKey("2026-2-28"), false);
});
