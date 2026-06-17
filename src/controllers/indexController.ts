import express from "express";
import path from "path";
import { ObjectId } from "mongodb";
import { connectDB, getFoodCollection } from "../db";
import { Accounts, FoodLog, foodLogToString } from "../utils/account-database";
import { FoodDatabase } from "../utils/food-database";
import { CoachAI } from "../coachAI";
import { OpenFoodFactsApi } from "../api/openFoodFactsApi";
const constants = require("../utils/constants");
const multer = require('multer');
const upload = multer(); // Creates a middleware instance

const username = "Lightning323"; // default

class IndexController {

    register(app: express.Application) {
        app.get("/", async (req, res) => {
            await connectDB(); // ensure DB is connected
            // await Accounts.newAccount(username); // create account if missing

            // Delete all food logs before today
            const deleteOut = await Accounts.clearAndLogCalorieHistory(username);

            const account = await Accounts.getAccount(username);
            if (!account) {
                return res.status(500).send("Account not found");
            }

            //TODO: Speed up the loading time of the app by sending this over via websocket
            //we need to get the actual food data from the food database and append it
            let todayFoods = await Promise.all(
                account.foods.map(async (f) => {
                    var foodItem = await FoodDatabase.getFoodByID(f.foodItem_id);
                    //if the food item is not found, use the backup
                    if (!foodItem && f.backup_foodItem) {
                        foodItem = f.backup_foodItem;
                    }
                    return { ...f, foodItem }; // add new property without mutating original
                })
            );
            todayFoods = todayFoods.reverse();

            const proteinGoal = account.proteinGoal ?? 150;
            const message = req.query.bulletinMessage || "";
            const foodHistory = account.foodHistory || {};
            const logData = `v${constants.getAppVersion() ?? "-unknown-"}\n ${deleteOut ?? ""}`;

            res.render("index", {
                username,
                appVersion: constants.getAppVersion(),
                todayFoods,
                foodHistory,
                calorieOffset: account.calorieOffset,
                maintenanceCalories: account.maintenanceCalories,
                proteinGoal,
                bulletinMessage: message,
                logData: logData
            });
        });

        /* ------------------ Log Food ------------------ */
        app.post("/log-food", upload.none(), async (req, res) => {
            const { foodItems } = req.body;
            let message = await CoachAI.logFood(username, foodItems, true);
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
}

export default IndexController