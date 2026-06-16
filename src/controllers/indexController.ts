import express from "express";
import path from "path";
import { ObjectId } from "mongodb";
import { connectDB, getFoodCollection } from "../db";
import { Accounts, FoodLog, foodLogToString } from "../utils/account-database";
import { FoodDatabase } from "../utils/food-database";
import { CoachAI } from "../coachAI";
import { OpenFoodFactsApi } from "../api/openFoodFactsApi";
const constants = require("../utils/constants");

const username = "Lightning323"; // default

class IndexController {

    register(app: express.Application) {
        app.get("/", async (req, res) => {
            await connectDB(); // ensure DB is connected
            // await Accounts.newAccount(username); // create account if missing

            // Delete all food logs before today
            const deleteOut = await Accounts.clearAndLogCalorieHistory(username);

            //Get only the fields we need so we don't send the entire account
            const account = await Accounts.getAccountWithFields(username, ["calorieOffset", "maintenanceCalories", "proteinGoal", "foods"]);
            if (!account) {
                return res.status(500).send("Account not found");
            }
            const proteinGoal = account.proteinGoal ?? 150;
            const message = req.query.bulletinMessage || "";
            const logData = `v${constants.getAppVersion() ?? "-unknown-"}\n ${deleteOut ?? ""}`;
            const todayFoods = await this.getFoodsLoggedToday(account);

            res.render("index", {
                username,
                appVersion: constants.getAppVersion(),
                calorieOffset: account.calorieOffset,
                maintenanceCalories: account.maintenanceCalories,
                proteinGoal,
                todayFoods,
                bulletinMessage: message,
                logData: logData,
                // foodHistory: await this.getNutritionHistory(account, todayFoods),
            });
        });

        /* ------------------ Log Food ------------------ */
        app.post("/log-food", async (req, res) => {
            const { foodItems, simpleAI } = req.body;
            var message = await CoachAI.logFood(username, foodItems, simpleAI === "true");
            res.redirect("/?bulletinMessage=" + encodeURIComponent(`${message}`));
        });

        app.post("/delete-food", async (req, res) => {
            const { foodLogId } = req.body;
            await Accounts.deleteFoodLog(username, foodLogId);
            res.redirect("/");
        });

        app.post("/edit-day-food", async (req, res) => {
            const { foodLogId, quantity, notes } = req.body;
            await Accounts.editFoodLog(username, foodLogId, {
                quantity: Number(quantity),
                notes,
            });
            res.redirect("/");
        });


        app.post("/nutrition-goals", async (req, res) => {

            const { maintenanceCalories, calorieOffset, proteinGoal } = req.body;
            if (maintenanceCalories === undefined || calorieOffset === undefined || proteinGoal === undefined) {
                return res.status(400).send("Missing goals");
            }
            await Accounts.setCalorieGoal(username, Number(maintenanceCalories), Number(calorieOffset));
            await Accounts.setProteinGoal(username, Number(proteinGoal));
            res.redirect("/");
        });

        app.get("/food-items", async (_req, res) => {
            const foods = await getFoodCollection().find().toArray();
            res.render("food-items", {
                foods,
                appVersion: constants.getAppVersion(),
            });
        });
    }

    async getFoodsLoggedToday(account: any) {
        //we need to get the actual food data from the food database and append it
        let todayFoods = await Promise.all(
            account.foods.map(async (f: any) => {
                var foodItem = await FoodDatabase.getFoodByID(f.foodItem_id);
                //if the food item is not found, use the backup
                if (!foodItem && f.backup_foodItem) {
                    foodItem = f.backup_foodItem;
                }
                return { ...f, foodItem }; // add new property without mutating original
            })
        );
        return todayFoods;
    }

    async getNutritionHistoryFromUsername(username: string) {
        const account = await Accounts.getAccount(username);
        if (!account) {
            return null;
        }
        const todayFoods = await this.getFoodsLoggedToday(account);
        //  console.log("GETTING NUTRITION HISTORY", account, todayFoods);
        return this.getNutritionHistory(account, todayFoods);
    }


    async getNutritionHistory(account: any, todayFoods: any[]) {
        if (!todayFoods || !account) return null;

        const foodHistory = account.foodHistory || {};

        todayFoods = todayFoods.reverse();
        const totalCalories = todayFoods.reduce((sum: any, f) => sum + (f.foodItem ? f.foodItem.calories * f.quantity : 0), 0);
        const totalProtein = todayFoods.reduce((sum: any, f) => sum + (f.foodItem ? (f.foodItem.protein ?? 0) * f.quantity : 0), 0);
        const totalCarbs = todayFoods.reduce((sum: any, f) => sum + (f.foodItem ? (f.foodItem.carbs ?? 0) * f.quantity : 0), 0);
        const totalFat = todayFoods.reduce((sum: any, f) => sum + (f.foodItem ? (f.foodItem.fat ?? 0) * f.quantity : 0), 0);


        //Get last N days sorted by date from most recent to least recent
        const sortedDates = Object.keys(foodHistory).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
        const today = new Date().setUTCHours(0, 0, 0, 0);

        const rangeEndMs = today; //Our end date (today)
        const historyTimeWindowDays = 30;
        const rangeStart = new Date(rangeEndMs);
        rangeStart.setUTCDate(rangeStart.getUTCDate() - historyTimeWindowDays);
        const rangeStartMs = rangeStart.getTime(); //Our start date (N days ago)

        //Get sorted dates, but only keep the ones that are between the start and end dates
        const lastNDates = sortedDates.filter(dateStr => {
            const d = new Date(dateStr).setUTCHours(0, 0, 0, 0);
            return d >= rangeStartMs && d <= rangeEndMs;
        }).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

        const totalCaloriesInRange = lastNDates.reduce((sum, date) => sum + (foodHistory[date].calories ?? 0), 0);
        const totalProteinInRange = lastNDates.reduce((sum, date) => sum + (foodHistory[date].protein ?? 0), 0);
        const totalCarbsInRange = lastNDates.reduce((sum, date) => sum + (foodHistory[date].carbs ?? 0), 0);
        const totalFatInRange = lastNDates.reduce((sum, date) => sum + (foodHistory[date].fat ?? 0), 0);

        return {
            foodHistory,
            historyStart: rangeStartMs,
            historyEnd: rangeEndMs,
            today: {
                totalCalories,
                totalProtein,
                totalCarbs,
                totalFat,
            },
            allTime: {
                totalCalories: totalCaloriesInRange,
                totalProtein: totalProteinInRange,
                totalCarbs: totalCarbsInRange,
                totalFat: totalFatInRange
            }
        }

    }
}

export default IndexController