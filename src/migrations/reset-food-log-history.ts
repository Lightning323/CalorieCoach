import { Document } from "mongodb";
import { closeDB, connectDB, getDB } from "../db";

type AccountDocument = Document & {
  foodLogsByDate?: unknown;
  foods?: unknown;
  foodHistory?: unknown;
};

function isFoodLogMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deliberately discards the old active-list and aggregate-history fields.
 * It is safe to re-run: accounts already using foodLogsByDate keep that map.
 */
async function main() {
  await connectDB();
  try {
    const accounts = getDB().collection<AccountDocument>("accounts");
    const legacyAccounts = await accounts.find({
      $or: [
        { foods: { $exists: true } },
        { foodHistory: { $exists: true } },
        { foodLogsByDate: { $exists: false } },
      ],
    }).toArray();

    for (const account of legacyAccounts) {
      await accounts.updateOne(
        { _id: account._id },
        {
          $set: {
            // Do not overwrite already-created logs if this command is re-run.
            foodLogsByDate: isFoodLogMap(account.foodLogsByDate) ? account.foodLogsByDate : {},
          },
          $unset: {
            foods: "",
            foodHistory: "",
          },
        },
      );
    }

    const remainingLegacyAccounts = await accounts.countDocuments({
      $or: [
        { foods: { $exists: true } },
        { foodHistory: { $exists: true } },
        { foodLogsByDate: { $exists: false } },
      ],
    });
    if (remainingLegacyAccounts > 0) {
      throw new Error(`${remainingLegacyAccounts} account(s) still use the legacy food-log model.`);
    }

    console.log(`Replaced legacy food-log data for ${legacyAccounts.length} account(s).`);
  } finally {
    await closeDB();
  }
}

main().catch(error => {
  console.error("Food-log model reset failed:", error);
  process.exitCode = 1;
});
