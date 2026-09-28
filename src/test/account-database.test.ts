import assert from "node:assert/strict";
import test from "node:test";
import {
  foodLogDateKey,
  foodLogDateTimeForDateKey,
  foodLogDateTimeFromLocalInput,
  isFoodLogDateKey,
  isValidTimeZone,
  shiftFoodLogDateKey,
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

test("shifts calendar-day keys without drifting across daylight-saving transitions", () => {
  // The old implementation treated days as 24 h and was off by one whenever a
  // shift crossed a DST boundary in the server's local timezone.
  assert.equal(shiftFoodLogDateKey("2026-03-08", 1), "2026-03-09");
  assert.equal(shiftFoodLogDateKey("2026-11-01", 1), "2026-11-02");
  assert.equal(shiftFoodLogDateKey("2026-03-08", -1), "2026-03-07");
  assert.equal(shiftFoodLogDateKey("2026-02-28", 1), "2026-03-01");
  assert.equal(shiftFoodLogDateKey("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftFoodLogDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftFoodLogDateKey("2026-01-01", 20), "2026-01-21");
});

test("rejects invalid timezone values while accepting real IANA identifiers", () => {
  assert.equal(isValidTimeZone("America/Boise"), true);
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("not-a-timezone"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(42), false);
});
