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
const MAX_CALORIE_HISTORY_LENGTH = 14;

export interface Account {
  _id?: ObjectId;
  username: string;
  password: string;
  calorieGoal: number;
  foods: FoodLog[];
  calorieHistory: number[];
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
        calorieHistory: [],
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
    entry: Omit<FoodLog, "_id">
  ) {
    return this.collection().updateOne(
      { username },
      {
        $set: { lastLoggedAt: new Date() },
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

  private async updateCalorieHistory(username: String) {
    const user = await this.collection().findOne(
      { username },
      { projection: { foods: 1, calorieHistory: 1 } }
    );
    if (!user) return;

    const foods = user.foods;

    // 🧮 Calculate yesterday's calories
    const yesterdayCalories = await this.calculateYesterdayCalories(foods);
    // ✍️ Log calories (or 0 if none)
    await this.collection().updateOne({ username },
      {
        $push: {
          calorieHistory: yesterdayCalories || 0,
        },
      }
    );
    //If the size of calorieHistory is greater than 7, remove the oldest entry
    if (user.calorieHistory.length > MAX_CALORIE_HISTORY_LENGTH) {
      await this.collection().updateOne({ username },
        {
          $pop: {
            calorieHistory: -1,
          },
        }
      );
    }
    console.log("yesterday's Calories", yesterdayCalories);
  }

  private async calculateYesterdayCalories(foods: FoodLog[]) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const yesterdayCalories = await Promise.all(
      foods
        .filter(food => {
          const d = new Date(food.logDate);
          d.setUTCHours(0, 0, 0, 0);
          return d.getTime() === yesterday.getTime();
        })
        .map(async (food) => {
          const foodItem = await FoodDatabase.getFoodByID(food.foodItem_id);
          if (foodItem) {
            return foodItem.calories * food.quantity;
          } else if (food.backup_foodItem) {
            return food.backup_foodItem.calories * food.quantity;
          } else {
            return 0;
          }
        })
    );

    return yesterdayCalories.reduce((sum, value) => sum + value, 0);
  }

  async clearAndlogCalorieHistory(username: string) {
    const user = await this.collection().findOne(
      { username },
      { projection: { foods: 1, calorieHistory: 1 } }
    );
    if (!user) return;

    const foods = user.foods ?? [];

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // 🧹 Delete food logs before today
    const idsToDelete = foods
      .filter(food => {
        const d = new Date(food.logDate);
        d.setUTCHours(0, 0, 0, 0);
        return d < today;
      })
      .map(food => food._id);

    if (idsToDelete.length > 0) {

      await this.updateCalorieHistory(username);

      console.log(`Deleting ${idsToDelete.length} food logs before today`);
      await this.collection().updateOne(
        { username },
        {
          $pull: {
            foods: { _id: { $in: idsToDelete } },
          },
        }
      );
    }
  }

}


/* 🔥 Singleton export */
export const Accounts = new AccountsService();
