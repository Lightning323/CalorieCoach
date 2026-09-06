import { Collection, ObjectId } from "mongodb";
import { getAccountsCollection } from "../db";
import { UsdaFoodPortion } from "../api/usdaFoodDataApi";
import { FoodItem, FoodPortion } from "./food-database";
import {
  foodLogDateKey,
  foodLogDateTimeForDateKey,
  getSafeTimeZone,
  isFoodLogDateKey,
} from "./food-log-dates";

export interface FoodLog {
  _id?: ObjectId;
  food?: FoodItem;
  foodItem_id?: ObjectId;
  backup_foodItem?: FoodItem;
  quantity: number;
  portion: FoodPortion;
  /** The precise time the entry was made; its map key owns its calendar day. */
  logDate?: Date;
  saveFood?: boolean;
  notes?: string;
}

/** Calendar date -> logs made on that account-local day. */
export type FoodLogsByDate = Record<string, FoodLog[]>;

/** Compact portion shape used while resolving a food before it is stored. */
export interface LoggedFoodPortion {
  amount: number;
  unit: string;
  grams: number;
  source?: string;
}

export interface Account {
  _id?: ObjectId;
  username: string;
  password: string;
  maintenanceCalories: number;
  calorieOffset: number;
  proteinGoal: number;
  foodLogsByDate: FoodLogsByDate;
  timezone: string;
  lastLoggedAt: Date;
  createdAt: Date;
}

export interface SavedFoodLogs {
  date: string;
  logs: FoodLog[];
}

class AccountsService {
  private collection(): Collection<Account> {
    return getAccountsCollection() as unknown as Collection<Account>;
  }

  async getAccount(username = "Lightning323") {
    return this.collection().findOne({ username });
  }

  async setTimezone(username: string, timezone: string) {
    return this.collection().updateOne({ username }, { $set: { timezone } });
  }

  /* ------------------ Food Logs ------------------ */
  async addFoodLog(
    username: string,
    entry: Omit<FoodLog, "_id" | "logDate">,
    targetDate?: string,
  ): Promise<FoodLog | undefined> {
    const { logs } = await this.addFoodLogs(username, [entry], targetDate);
    return logs[0];
  }

  async addFoodLogs(
    username: string,
    entries: Array<Omit<FoodLog, "_id" | "logDate">>,
    targetDate?: string,
  ): Promise<SavedFoodLogs> {
    if (entries.length === 0) {
      return { date: foodLogDateKey(new Date(), "UTC"), logs: [] };
    }

    if (targetDate !== undefined && !isFoodLogDateKey(targetDate)) {
      throw new Error("Invalid food-log date.");
    }

    const account = await this.collection().findOne(
      { username },
      { projection: { timezone: 1 } },
    );
    if (!account) throw new Error(`Account \"${username}\" was not found.`);

    const timezone = getSafeTimeZone(account.timezone);
    const now = new Date();
    const today = foodLogDateKey(now, timezone);
    const date = targetDate ?? today;
    if (date > today) throw new Error("Food can only be logged for today or a previous day.");

    // AI logging targets a day rather than a precise meal time. Midday avoids
    // timezone/DST boundary shifts while preserving the selected calendar day.
    const logDate = targetDate ? foodLogDateTimeForDateKey(targetDate, timezone) : now;
    const savedLogs: FoodLog[] = entries.map(entry => ({
      ...entry,
      _id: new ObjectId(),
      logDate,
    }));
    const datePath = `foodLogsByDate.${date}`;

    await this.collection().updateOne(
      { username },
      {
        $set: { lastLoggedAt: logDate },
        $push: {
          [datePath]: {
            $each: savedLogs,
          },
        },
      } as any,
    );

    return { date, logs: savedLogs };
  }

  async deleteFoodLog(username: string, date: string, foodLogId: string) {
    if (!isFoodLogDateKey(date) || !ObjectId.isValid(foodLogId)) {
      throw new Error("Invalid food-log date or ID.");
    }

    return this.collection().updateOne(
      { username },
      {
        $pull: {
          [`foodLogsByDate.${date}`]: {
            _id: new ObjectId(foodLogId),
          },
        },
      } as any,
    );
  }

  async editFoodLog(
    username: string,
    date: string,
    foodLogId: string,
    updates: {
      quantity?: number;
      portionAmount?: number;
      portion?: UsdaFoodPortion;
      notes?: string;
      logDate?: Date;
      targetDate?: string;
    },
  ) {
    if (!isFoodLogDateKey(date) || !ObjectId.isValid(foodLogId)) {
      throw new Error("Invalid food-log date or ID.");
    }

    const targetDate = updates.targetDate ?? date;
    if (!isFoodLogDateKey(targetDate)) {
      throw new Error("Invalid target food-log date.");
    }

    const objectId = new ObjectId(foodLogId);
    const datePath = `foodLogsByDate.${date}`;
    const shouldMove = targetDate !== date;
    const setFields: Record<string, unknown> = {};

    const needsExistingLog = shouldMove || updates.portionAmount !== undefined;
    const account = needsExistingLog
      ? await this.collection().findOne(
        { username, [`${datePath}._id`]: objectId },
        { projection: { [`foodLogsByDate.${date}`]: 1 } },
      )
      : null;
    const existingLog = account?.foodLogsByDate?.[date]?.find(log => log._id?.equals(objectId));

    if (shouldMove && !existingLog) return;

    if (updates.portion) {
      setFields[`${datePath}.$.portion`] = updates.portion;
      if (updates.quantity !== undefined) setFields[`${datePath}.$.quantity`] = updates.quantity;
    } else if (updates.portionAmount !== undefined) {
      const existingPortion = existingLog?.portion;
      const existingAmount = existingPortion?.amount;
      const existingGrams = existingPortion?.gramWeight ?? existingPortion?.grams;

      if (
        existingAmount !== undefined && existingAmount > 0
        && existingGrams !== undefined && existingGrams > 0
      ) {
        const scale = updates.portionAmount / existingAmount;
        const grams = existingGrams * scale;
        setFields[`${datePath}.$.quantity`] = grams / 100;
        setFields[`${datePath}.$.portion.amount`] = updates.portionAmount;
        setFields[`${datePath}.$.portion.gramWeight`] = grams;
      } else if (updates.quantity !== undefined) {
        setFields[`${datePath}.$.quantity`] = updates.quantity;
      }
    } else if (updates.quantity !== undefined) {
      setFields[`${datePath}.$.quantity`] = updates.quantity;
    }

    if (updates.notes !== undefined) setFields[`${datePath}.$.notes`] = updates.notes;
    if (updates.logDate !== undefined) setFields[`${datePath}.$.logDate`] = updates.logDate;

    if (shouldMove) {
      const movedLog: FoodLog = { ...existingLog! };
      if (updates.portion) {
        movedLog.portion = updates.portion as FoodPortion;
        if (updates.quantity !== undefined) movedLog.quantity = updates.quantity;
      } else if (updates.portionAmount !== undefined) {
        const existingPortion = movedLog.portion;
        const existingAmount = existingPortion?.amount;
        const existingGrams = existingPortion?.gramWeight ?? existingPortion?.grams;
        if (
          existingAmount !== undefined && existingAmount > 0
          && existingGrams !== undefined && existingGrams > 0
        ) {
          const scale = updates.portionAmount / existingAmount;
          const grams = existingGrams * scale;
          movedLog.quantity = grams / 100;
          movedLog.portion = {
            ...existingPortion,
            amount: updates.portionAmount,
            gramWeight: grams,
          };
        } else if (updates.quantity !== undefined) {
          movedLog.quantity = updates.quantity;
        }
      } else if (updates.quantity !== undefined) {
        movedLog.quantity = updates.quantity;
      }
      if (updates.notes !== undefined) movedLog.notes = updates.notes;
      if (updates.logDate !== undefined) movedLog.logDate = updates.logDate;

      return this.collection().updateOne(
        { username, [`${datePath}._id`]: objectId },
        {
          $pull: { [datePath]: { _id: objectId } },
          $push: { [`foodLogsByDate.${targetDate}`]: movedLog },
        } as any,
      );
    }

    if (Object.keys(setFields).length === 0) return;

    return this.collection().updateOne(
      { username, [`${datePath}._id`]: objectId },
      { $set: setFields },
    );
  }

  /* ------------------ Nutrition goals ------------------ */
  async setCalorieGoal(username: string, maintenanceCalories: number, calorieOffset: number) {
    if (maintenanceCalories < 100) maintenanceCalories = 100;

    if (maintenanceCalories + calorieOffset < 100) {
      calorieOffset = 100 - maintenanceCalories;
    }

    return this.collection().updateOne(
      { username },
      { $set: { maintenanceCalories, calorieOffset } },
    );
  }

  async setProteinGoal(username: string, goal: number) {
    if (goal < 0) goal = 0;
    return this.collection().updateOne(
      { username },
      { $set: { proteinGoal: goal } },
    );
  }
}

export const Accounts = new AccountsService();
