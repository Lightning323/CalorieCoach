"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Accounts = void 0;
exports.foodLogToString = foodLogToString;
exports.accountToString = accountToString;
const mongodb_1 = require("mongodb");
const db_1 = require("../db");
function foodLogToString(log) {
    return `FoodLog: ${log.foodItem_id} | Quantity: ${log.quantity} | Notes: ${log.notes} | Logged At: ${log.logDate}`;
}
function accountToString(account) {
    const foods = account.foods.map(foodLogToString).join("\n  ");
    return `Account: ${account.username} | Calorie Goal: ${account.calorieGoal}\nFoods:\n  ${foods}`;
}
/* ------------------ Service ------------------ */
class AccountsService {
    collection() {
        return (0, db_1.getAccountsCollection)();
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
            return account2;
        }
        return account;
    }
    /* Get account */
    async getAccount(username = "Lightning323") {
        return this.collection().findOne({ username });
    }
    /* ------------------ Food Logs ------------------ */
    async addFoodLog(username, entry) {
        return this.collection().updateOne({ username }, {
            $push: {
                foods: {
                    ...entry,
                    _id: new mongodb_1.ObjectId(),
                },
            },
        });
    }
    async deleteFoodLog(username, foodLogId) {
        return this.collection().updateOne({ username }, {
            $pull: {
                foods: {
                    _id: new mongodb_1.ObjectId(foodLogId), // use FoodLog's _id
                }, // TS hack
            },
        });
    }
    async editFoodLog(username, foodLogId, updates) {
        const setFields = {};
        if (updates.quantity !== undefined)
            setFields["foods.$.quantity"] = updates.quantity;
        if (updates.notes !== undefined)
            setFields["foods.$.notes"] = updates.notes;
        return this.collection().updateOne({
            username,
            "foods._id": new mongodb_1.ObjectId(foodLogId), // updated to FoodLog _id
        }, {
            $set: setFields,
        });
    }
    /* ------------------ Update calorie goal ------------------ */
    async setCalorieGoal(username, goal) {
        return this.collection().updateOne({ username }, { $set: { calorieGoal: goal } });
    }
    /* Foods logged today */
    async getTodayFoods(username) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const account = await this.collection().findOne({ username });
        if (!account)
            return [];
        return account.foods.filter(f => f.logDate >= start);
    }
    async deleteFoodsBeforeToday(username) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const account = await this.collection().findOne({ username });
        if (!account)
            return 0;
        const originalCount = account.foods.length;
        account.foods = account.foods.filter(f => f.logDate >= start);
        const deletedCount = originalCount - account.foods.length;
        await this.collection().updateOne({ username }, { $set: { foods: account.foods } });
        return deletedCount;
    }
}
/* 🔥 Singleton export */
exports.Accounts = new AccountsService();
