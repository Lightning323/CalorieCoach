import { formatInTimeZone } from "date-fns-tz";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
