import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Returns a usable IANA timezone, defaulting safely for accounts without one. */
export function getSafeTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";

  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Converts an instant into the account-local `YYYY-MM-DD` storage key. */
export function foodLogDateKey(date: Date, timeZone: string | undefined): string {
  return formatInTimeZone(date, getSafeTimeZone(timeZone), "yyyy-MM-dd");
}

/** Validates a calendar-date map key, not merely its string shape. */
export function isFoodLogDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Treats a date key as a timezone-independent calendar date for navigation. */
export function dateFromFoodLogKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

/**
 * Converts the value submitted by a `datetime-local` control into an instant
 * in the account's timezone. The control has no timezone information of its
 * own, so it must be interpreted in the same timezone that owns food-log
 * calendar-day keys.
 */
export function foodLogDateTimeFromLocalInput(
  value: unknown,
  timeZone: string | undefined,
): Date | null {
  if (typeof value !== "string") return null;

  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;

  const [, dateKey, hourText, minuteText, secondText = "00"] = match;
  if (!isFoodLogDateKey(dateKey)) return null;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const safeTimeZone = getSafeTimeZone(timeZone);
  const normalized = `${dateKey}T${hourText}:${minuteText}:${secondText}`;
  const instant = fromZonedTime(normalized, safeTimeZone);
  if (Number.isNaN(instant.getTime())) return null;

  // Reject local times skipped by daylight-saving transitions instead of
  // silently moving the entry to a different time.
  return formatInTimeZone(instant, safeTimeZone, "yyyy-MM-dd'T'HH:mm:ss") === normalized
    ? instant
    : null;
}

/** Creates a stable midday timestamp for an AI entry assigned to a calendar day. */
export function foodLogDateTimeForDateKey(dateKey: string, timeZone: string | undefined): Date {
  if (!isFoodLogDateKey(dateKey)) throw new Error("Invalid food-log date.");

  const instant = foodLogDateTimeFromLocalInput(`${dateKey}T12:00`, timeZone);
  if (!instant) throw new Error("Unable to create a food-log timestamp for this date.");
  return instant;
}
