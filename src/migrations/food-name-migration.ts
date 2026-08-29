import { normalizeFoodNames } from "../utils/food-database";

/** The subset of a stored food record relevant to the names migration. */
export interface LegacyFoodNameRecord {
  names?: unknown;
  name?: unknown;
}

/**
 * Produces the canonical aliases for a pre-migration food record. Existing
 * aliases remain first, and the former singular name is retained as an alias.
 */
export function migrateFoodNames(record: LegacyFoodNameRecord): string[] {
  const existingNames = Array.isArray(record.names) ? record.names : [];
  const names = normalizeFoodNames([...existingNames, record.name]);
  if (names.length === 0) {
    throw new Error("Food has no usable name and cannot be migrated.");
  }
  return names;
}

export function foodNameMigrationRequired(record: LegacyFoodNameRecord): boolean {
  const names = migrateFoodNames(record);
  const storedNames = Array.isArray(record.names) ? record.names : [];
  const hasLegacyName = Object.prototype.hasOwnProperty.call(record, "name");
  return hasLegacyName ||
    storedNames.length !== names.length ||
    storedNames.some((name, index) => name !== names[index]);
}
