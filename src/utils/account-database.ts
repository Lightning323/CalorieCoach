import { ObjectId, Collection } from "mongodb";
import { getAccountsCollection } from "../db";
import { FoodItem, FoodDatabase } from "./food-database";
/* ------------------ Types ------------------ */

export interface FoodLog {
  _id?: ObjectId;
  foodItem_id?: ObjectId;
  backup_foodItem?: FoodItem;
  quantity: number;
  notes: string;
  logDate: Date;
}

export interface Account {
  _id?: ObjectId;
  username: string;
  password: string;
  calorieGoal: number;
  foods: FoodLog[];
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
    entry: Omit<FoodLog, "_id">
  ) {
    return this.collection().updateOne(
      { username },
      {
        $push: {
          foods: {
            ...entry,
            _id: new ObjectId(),
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

  async getAllFoods(username: string) {
    const account = await this.collection().findOne({ username });
    if (!account) return [];
    return account.foods;
  }

  async deleteFoodsBeforeToday(username: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const result = await this.collection().updateOne(
      { username },
      { $pull: { foods: { logDate: { $lt: start } } } }
    );
    return result.modifiedCount;
  }
}

/* 🔥 Singleton export */
export const Accounts = new AccountsService();
