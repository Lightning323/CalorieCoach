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

    register(io: any, app: express.Application) {
        io.on("connection", (socket: any) => {
            socket.on("log-food", async (payload: { foodItems?: unknown } = {}) => {
                const foodItems = typeof payload.foodItems === "string" ? payload.foodItems.trim() : "";

                if (!foodItems) {
                    socket.emit("food-log-error", { message: "Please enter at least one food item." });
                    return;
                }

                // Acknowledge right away so the browser can remain usable while the AI works.
                socket.emit("food-log-queued");

                try {
                    const message = await CoachAI.logFood(username, foodItems);
                    const completedMessage = String(message);

                    if (/^(Successfully logged|Logged \d+ items)/.test(completedMessage)) {
                        // Every open view updates only after the food log has been persisted.
                        io.emit("food-logged", { message: completedMessage });
                    } else {
                        socket.emit("food-log-error", { message: completedMessage });
                    }
                } catch (err) {
                    console.error("Unable to log food:", err);
                    socket.emit("food-log-error", { message: "Unable to log food. Please try again." });
                }
            });
        });

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
