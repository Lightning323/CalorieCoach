import { ObjectId, Collection } from "mongodb";
import { getAccountsCollection } from "./db";

/* ------------------ Types ------------------ */

export interface FoodEntry {
  _id?: ObjectId;
  name: string;
  quantity: string;
  calories: number;
  loggedAt: Date;
}

export interface Account {
  _id?: ObjectId;
  username: string;
  password: string;
  calorieGoal: number;
  foods: FoodEntry[];
  createdAt: Date;
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

  /* Add food */
  async addFood(
    username: string,
    food: Omit<FoodEntry, "loggedAt" | "_id">
  ) {
    return this.collection().updateOne(
      { username },
      {
        $push: {
          foods: {
            ...food,
            _id: new ObjectId(),
            loggedAt: new Date(),
          },
        },
      }
    );
  }

  /* Delete food */
  async deleteFood(username: string, foodId: string) {
    return this.collection().updateOne(
      { username },
      {
        $pull: {
          foods: { _id: new ObjectId(foodId) },
        },
      }
    );
  }

  /* Update calorie goal */
  async setCalorieGoal(username: string, goal: number) {
    return this.collection().updateOne(
      { username },
      { $set: { calorieGoal: goal } }
    );
  }

  /* Foods logged today */
  async getTodayFoods(username: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const account = await this.collection().findOne({ username });

    if (!account) return [];

    return account.foods.filter(f => f.loggedAt >= start);
  }

  /* Total calories today */
  async getTodayCalories(username: string) {
    const foods = await this.getTodayFoods(username);
    return foods.reduce((sum, f) => sum + f.calories, 0);
  }
}

/* 🔥 Singleton export */
export const Accounts = new AccountsService();
