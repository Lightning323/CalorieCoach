import { AnyBulkWriteOperation, ObjectId } from "mongodb";
import { closeDB, connectDB, getAccountsCollection, getFoodCollection } from "../db";
import { foodNameMigrationRequired, LegacyFoodNameRecord, migrateFoodNames } from "./food-name-migration";

interface StoredFood extends LegacyFoodNameRecord {
  _id: ObjectId;
}

interface StoredFoodLog {
  _id?: ObjectId;
  backup_foodItem?: StoredFood;
}

interface StoredAccount {
  _id: ObjectId;
  foods?: StoredFoodLog[];
}

async function migrate() {
  await connectDB();
  const foodCollection = getFoodCollection();
  const accountsCollection = getAccountsCollection();
  const [storedFoods, accounts] = await Promise.all([
    foodCollection.find({}).toArray() as Promise<StoredFood[]>,
    accountsCollection.find({}, { projection: { foods: 1 } }).toArray() as Promise<StoredAccount[]>,
  ]);

  const foodOperations: AnyBulkWriteOperation[] = [];
  const backupOperations: AnyBulkWriteOperation[] = [];
  const invalidRecords: string[] = [];

  for (const food of storedFoods) {
    try {
      if (!foodNameMigrationRequired(food)) continue;
      foodOperations.push({
        updateOne: {
          filter: { _id: food._id },
          update: {
            $set: { names: migrateFoodNames(food) },
            $unset: { name: "" },
          },
        },
      });
    } catch (error) {
      invalidRecords.push(`food ${food._id.toHexString()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const account of accounts) {
    for (const [index, log] of (account.foods ?? []).entries()) {
      const backupFood = log.backup_foodItem;
      if (!backupFood) continue;

      try {
        if (!foodNameMigrationRequired(backupFood)) continue;
        if (!log._id) {
          invalidRecords.push(`account ${account._id.toHexString()} food log ${index}: missing log ID`);
          continue;
        }
        backupOperations.push({
          updateOne: {
            filter: { _id: account._id, "foods._id": log._id },
            update: {
              $set: { "foods.$.backup_foodItem.names": migrateFoodNames(backupFood) },
              $unset: { "foods.$.backup_foodItem.name": "" },
            },
          },
        });
      } catch (error) {
        invalidRecords.push(
          `account ${account._id.toHexString()} food log ${index}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Validate every record before changing anything, so malformed data does
  // not leave a partially migrated database behind.
  if (invalidRecords.length > 0) {
    throw new Error(`Food-name migration stopped; fix these records first:\n${invalidRecords.join("\n")}`);
  }

  const [foodsResult, backupsResult] = await Promise.all([
    foodOperations.length > 0 ? foodCollection.bulkWrite(foodOperations, { ordered: true }) : undefined,
    backupOperations.length > 0 ? accountsCollection.bulkWrite(backupOperations, { ordered: true }) : undefined,
  ]);
  const updatedFoods = foodsResult?.modifiedCount ?? 0;
  const updatedBackups = backupsResult?.modifiedCount ?? 0;
  console.log(`Migrated ${updatedFoods} food records and ${updatedBackups} backup food records to names[].`);
}

migrate()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDB);
