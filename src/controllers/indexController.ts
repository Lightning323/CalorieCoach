import express from "express";
import { connectDB } from "../db";
import { Accounts } from "../utils/account-database";
import { FoodDatabase } from "../utils/food-database";
import { CoachAI } from "../coachAI";
import { config, TRACKED_NUTRIENTS } from "../config";

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
                    const message = await CoachAI.logFood(config.defaultUsername, foodItems);
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
            // Delete all food logs before today
            const deleteOut = await Accounts.clearAndLogCalorieHistory(config.defaultUsername);
            const account = await Accounts.getAccount(config.defaultUsername);
            if (!account) {
                return res.status(500).send("Account not found");
            }

            // Load every referenced food in one query. This route is called as
            // soon as food logging completes, so per-item lookups made larger
            // meals visibly slower to appear.
            const foodsById = await FoodDatabase.getFoodsByIDs(account.foods.map(food => food.foodItem_id));
            const todayFoods = [...account.foods]
                .reverse()
                .map(food => ({
                    ...food,
                    foodItem: food.foodItem_id
                        ? foodsById.get(food.foodItem_id.toHexString()) ?? food.backup_foodItem
                        : food.backup_foodItem,
                }));

            const proteinGoal = account.proteinGoal ?? 150;
            const message = req.query.bulletinMessage || "";
            const foodHistory = account.foodHistory || {};
            const logData = `v${config.appVersion ?? "-unknown-"}\n ${deleteOut ?? ""}`;

            res.render("index", {
                username: config.defaultUsername,
                appVersion: config.appVersion,
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
            await Accounts.deleteFoodLog(config.defaultUsername, foodLogId);
            res.redirect("/");
        });

        app.post("/edit-day-food", async (req, res) => {
            const { foodLogId, quantity, notes } = req.body;
            await Accounts.editFoodLog(config.defaultUsername, foodLogId, {
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
            await Accounts.setCalorieGoal(config.defaultUsername, Number(maintenanceCalories), Number(calorieOffset));
            await Accounts.setProteinGoal(config.defaultUsername, Number(proteinGoal));
            res.redirect("/");
        });

        app.get("/food-items", async (_req, res) => {
            const foods = await FoodDatabase.getAllFoods();
            // Keep the database grid consistent even when two foods contain
            // different nutrient profiles. The configured USDA nutrients come
            // first, followed by any additional nutrients already in the DB.
            const metricNames = [...new Set([
                ...Object.values(TRACKED_NUTRIENTS),
                ...foods.flatMap(food => Object.keys(food.metrics ?? {})),
            ])];

            res.render("food-items", {
                foods,
                metricNames,
                appVersion: config.appVersion,
            });
        });
    }
}

export default IndexController
