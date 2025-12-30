import { ObjectId, Collection } from "mongodb";
import { getAccountsCollection } from "../db";
import { FoodItem, FoodDatabase } from "./food-database";
import { startOfDay, isBefore, parseISO, differenceInDays, differenceInCalendarDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
/* ------------------ Types ------------------ */




export interface FoodLog {
  _id?: ObjectId;
  foodItem_id?: ObjectId;
  backup_foodItem?: FoodItem;
  quantity: number;
  notes: string;
  logDate?: string;
}
const MAX_CALORIE_HISTORY_LENGTH = 14;

export interface Account {
  _id?: ObjectId;
  username: string;
  password: string;
  backendDebugMessage: string;
  calorieGoal: number;
  foods: FoodLog[];
  calorieHistory: Record<string, number>; //Date -> Calories
  lastLoggedAt: Date;
  createdAt: Date;
}

export function foodLogToString(log: FoodLog): string {
  return `FoodLog: ${log.foodItem_id} | Quantity: ${log.quantity} | Notes: ${log.notes} | Logged At: ${log.logDate}`;
}

export function accountToString(account: Account): string {
  const foods = account.foods.map(foodLogToString).join("\n  ");
  return `Account: ${account.username} | Calorie Goal: ${account.calorieGoal}\nFoods:\n  ${foods}`;
}


/* ------------------ Service ------------------ */

class AccountsService {
  private collection(): Collection<Account> {
    return getAccountsCollection() as unknown as Collection<Account>;
  }

  /* new account account */
  async newAccount(username = "Lightning323") {
    const col = this.collection();

    let account = await this.getAccount(username);

    if (!account) {
      const account2 = {
        username,
        password: "",
        backendDebugMessage: "",
        calorieHistory: {},
        lastLoggedAt: new Date(),
        calorieGoal: 2000,
        foods: [],
        createdAt: new Date(),
      };

      await col.insertOne(account2);
      console.log(`👤 Created account: ${username}`);
      return account2
    }

    return account;
  }

  /* Get account */
  async getAccount(username = "Lightning323") {
    return this.collection().findOne({ username });
  }

  /* ------------------ Food Logs ------------------ */
  async addFoodLog(
    username: string,
    entry: Omit<FoodLog, "_id" | "logDate">
  ) {
    return this.collection().updateOne(
      { username },
      {
        $set: { lastLoggedAt: new Date() },
        $push: {
          foods: {
            ...entry,
            _id: new ObjectId(),
            logDate: new Date().toISOString(),
          },
        },
      }
    );
  }



  async deleteFoodLog(username: string, foodLogId: string) {
    return this.collection().updateOne(
      { username },
      {
        $pull: {
          foods: {
            _id: new ObjectId(foodLogId), // use FoodLog's _id
          } as any, // TS hack
        },
      }
    );
  }

  async editFoodLog(
    username: string,
    foodLogId: string,
    updates: {
      quantity?: number;
      notes?: string;
    }
  ) {
    const setFields: any = {};

    if (updates.quantity !== undefined)
      setFields["foods.$.quantity"] = updates.quantity;

    if (updates.notes !== undefined)
      setFields["foods.$.notes"] = updates.notes;

    return this.collection().updateOne(
      {
        username,
        "foods._id": new ObjectId(foodLogId), // updated to FoodLog _id
      },
      {
        $set: setFields,
      }
    );
  }



  /* ------------------ Update calorie goal ------------------ */
  async setCalorieGoal(username: string, goal: number) {
    return this.collection().updateOne(
      { username },
      { $set: { calorieGoal: goal } }
    );
  }


  private async updateCalorieHistory(username: string) {
    const user = await this.collection().findOne(
      { username },
      { projection: { foods: 1, calorieHistory: 1 } }
    );
    if (!user) return;

    const foods = user.foods || [];
    const calorieHistory = user.calorieHistory || {};

    const today = startOfDay(new Date());

    for (const food of foods) {
      const date = startOfDay(parseISO(food.logDate ?? "")); // parse as ISO and get start of day
      if (!isBefore(date, today)) continue; // skip today or future
      const key = formatInTimeZone(date, "UTC", "yyyy-MM-dd");

      let calories = 0;
      if (food.foodItem_id) {
        const foodItem = await FoodDatabase.getFoodByID(food.foodItem_id);
        if (foodItem) calories = foodItem.calories * food.quantity;
      } else if (food.backup_foodItem) {
        calories = food.backup_foodItem.calories * food.quantity;
      }

      calorieHistory[key] = (calorieHistory[key] || 0) + calories;
    }

    // Limit history length
    const keys = Object.keys(calorieHistory).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime()
    );
    if (keys.length > MAX_CALORIE_HISTORY_LENGTH) {
      const keysToRemove = keys.slice(0, keys.length - MAX_CALORIE_HISTORY_LENGTH);
      keysToRemove.forEach(k => delete calorieHistory[k]);
    }

    await this.collection().updateOne(
      { username },
      { $set: { calorieHistory } }
    );
    console.log("Updated calorie history:", calorieHistory);
  }


  async clearAndLogCalorieHistory(username: string): Promise<string> {
    let output = "";

    const log = (...args: any[]) => {
      const line = args.join(" ");
      output += line + "\n";
      console.log(line);
    };

    const user = await this.collection().findOne(
      { username },
      { projection: { foods: 1, calorieHistory: 1 } }
    );
    if (!user) {
      return output;
    }

    const foods = user.foods ?? [];

    const todayUTC = new Date(); // now
    log("Now UTC:", todayUTC.toISOString());

    const idsToDelete = foods
      .map(food => {
        const logDateUTC = parseISO(food.logDate ?? "");
        const daysBeforeToday = differenceInCalendarDays(todayUTC, logDateUTC);
        log(`Log date UTC: ${logDateUTC.toISOString()} \t ${daysBeforeToday} Days before today`);
        return { _id: food._id, delete: daysBeforeToday > 0 };
      })
      .filter(f => f.delete)
      .map(f => f._id);


    log(`Total logs to delete: ${idsToDelete.length}`);

    if (idsToDelete.length > 0) {
      log("Updating calorie history before deletion...");
      await this.updateCalorieHistory(username);

      log(`Deleting ${idsToDelete.length} food log(s) before today...`);
      await this.collection().updateOne(
        { username },
        { $pull: { foods: { _id: { $in: idsToDelete } } } }
      );
      await this.collection().updateOne(
        { username },
        { $set: { backendDebugMessage: output } }
      );
      return output;
    } else {
      return output;
    }
  }



}


/* 🔥 Singleton export */
export const Accounts = new AccountsService();
