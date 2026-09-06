import assert from "node:assert/strict";
import test from "node:test";
import {
  foodLogDateKey,
  foodLogDateTimeForDateKey,
  foodLogDateTimeFromLocalInput,
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

test("converts a datetime-local value using the account timezone", () => {
  const loggedAt = foodLogDateTimeFromLocalInput("2026-09-05T20:45", "America/Denver");

  assert.equal(loggedAt?.toISOString(), "2026-09-06T02:45:00.000Z");
  assert.equal(foodLogDateKey(loggedAt!, "America/Denver"), "2026-09-05");
  assert.equal(foodLogDateTimeFromLocalInput("2026-02-29T12:00", "UTC"), null);
  assert.equal(foodLogDateTimeFromLocalInput("2026-09-05T24:00", "UTC"), null);
  assert.equal(
    foodLogDateTimeForDateKey("2026-09-05", "America/Denver").toISOString(),
    "2026-09-05T18:00:00.000Z",
  );
});
