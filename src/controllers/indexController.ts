import express from "express";
import { connectDB, getFoodCollection } from "../db";
import { Accounts } from "../utils/account-database";
import { FoodDatabase } from "../utils/food-database";
import { CoachAI } from "../coachAI";
import { DEFAULT_USERNAME, getAppVersion } from "../utils/constants";

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
                    const message = await CoachAI.logFood(DEFAULT_USERNAME, foodItems);
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
            // await Accounts.newAccount(DEFAULT_USERNAME); // create account if missing

            // Delete all food logs before today
            const deleteOut = await Accounts.clearAndLogCalorieHistory(DEFAULT_USERNAME);

            const account = await Accounts.getAccount(DEFAULT_USERNAME);
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
            const logData = `v${getAppVersion() ?? "-unknown-"}\n ${deleteOut ?? ""}`;

            res.render("index", {
                username: DEFAULT_USERNAME,
                appVersion: getAppVersion(),
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
            await Accounts.deleteFoodLog(DEFAULT_USERNAME, foodLogId);
            res.redirect("/");
        });

        app.post("/edit-day-food", async (req, res) => {
            const { foodLogId, quantity, notes } = req.body;
            await Accounts.editFoodLog(DEFAULT_USERNAME, foodLogId, {
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
            await Accounts.setCalorieGoal(DEFAULT_USERNAME, Number(maintenanceCalories), Number(calorieOffset));
            await Accounts.setProteinGoal(DEFAULT_USERNAME, Number(proteinGoal));
            res.redirect("/");
        });

        app.get("/food-items", async (_req, res) => {
            const foods = await getFoodCollection().find().toArray();
            res.render("food-items", {
                foods,
                appVersion: getAppVersion(),
            });
        });
    }
}

export default IndexController
