import express from "express";
import { ObjectId } from "mongodb";
import { connectDB } from "../db";
import { Accounts } from "../utils/account-database";
import { FoodDatabase } from "../utils/food-database";
import { FoodLoggerAPI } from "../coach-ai/food-log-service";
import { config, TRACKED_NUTRIENTS } from "../config";
import { UsdaFoodDataApi } from "../api/usdaFoodDataApi";
import { foodPortionsFromUsda } from "../coach-ai/usda-food-resolver";
import { getUsdaFoodNutrientsPer100g } from "../api/usdaFoodDataApi";
import { scaleLoggedFoodNutrients } from "../utils/logged-food-nutrition";

class IndexController {

    constructor(
        private readonly foodLoggerAPI = new FoodLoggerAPI()
    ){

    }

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
                    const result = await this.foodLoggerAPI.logFood(
                        config.defaultUsername,
                        foodItems,
                        progress => socket.emit("food-log-progress", progress),
                    );

                    if (result.success) {
                        // Broadcast only after persistence; pages append these entries without a reload.
                        io.emit("food-logged", { message: result.message, entries: result.entries });
                    } else {
                        socket.emit("food-log-error", { message: result.message });
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
                .map(food => {
                    const foodItem = food.foodItem_id
                        ? foodsById.get(food.foodItem_id.toHexString()) ?? food.backup_foodItem
                        : food.backup_foodItem;
                    return { ...food, foodItem, nutrition: foodItem ? scaleLoggedFoodNutrients(foodItem.foodNutrients, food.quantity, food.portion) : {} };
                });

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

        app.post("/add-database-food-log", async (req, res) => {
            const foodId = typeof req.body?.foodId === "string" ? req.body.foodId : "";
            if (!ObjectId.isValid(foodId)) return res.status(400).json({ message: "Invalid food ID." });

            const food = await FoodDatabase.getFoodByID(new ObjectId(foodId));
            if (!food) return res.status(404).json({ message: "Food not found." });
            const portion = [...food.foodPortions].sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0))[0];
            if (!portion) return res.status(400).json({ message: "Food has no available portion." });

            const [foodLog] = await Accounts.addFoodLog(config.defaultUsername, {
                foodItem_id: food._id,
                backup_foodItem: food,
                quantity: 1,
                portion,
                notes: "",
            } as any);
            const foodLogId = foodLog?._id?.toHexString();
            if (!foodLogId) return res.status(500).json({ message: "Food was added, but could not be opened for editing." });
            res.status(201).json({ foodLogId });
        });

        app.post("/edit-day-food", async (req, res) => {
            const { foodLogId, quantity, portionAmount, portionGramWeight, portionUnit, notes } = req.body;
            const parsedPortionAmount = Number(portionAmount);
            const parsedPortionGramWeight = Number(portionGramWeight);
            const parsedPortionQuantity = Number(quantity);
            const normalizedPortionUnit = typeof portionUnit === "string" ? portionUnit.trim() : "";
            const hasSelectedPortion = Number.isFinite(parsedPortionAmount) && parsedPortionAmount > 0
              && Number.isFinite(parsedPortionGramWeight) && parsedPortionGramWeight > 0
              && Number.isFinite(parsedPortionQuantity) && parsedPortionQuantity > 0
              && normalizedPortionUnit.length > 0 && normalizedPortionUnit.length <= 160;
            await Accounts.editFoodLog(config.defaultUsername, foodLogId, {
              quantity: Number(quantity),
              ...(hasSelectedPortion
                ? {
                  portion: {
                    amount: parsedPortionAmount,
                    gramWeight: parsedPortionGramWeight,
                    measureUnit: { name: normalizedPortionUnit },
                  },
                }
                : {}),
              ...(!hasSelectedPortion && Number.isFinite(parsedPortionAmount) && parsedPortionAmount > 0
                ? { portionAmount: parsedPortionAmount }
                : {}),
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

        app.get("/food-items", async (req, res) => {
            const foods = await FoodDatabase.getAllFoods();
            let initialFood;
            const usdaId = Number(req.query.usda);
            if (Number.isSafeInteger(usdaId) && usdaId > 0) {
                try {
                    const usdaFood = await UsdaFoodDataApi.getFoodById(usdaId);
                    initialFood = {
                        names: [usdaFood.description],
                        foodNutrients: getUsdaFoodNutrientsPer100g(usdaFood),
                        foodPortions: foodPortionsFromUsda(usdaFood),
                        source: "USDA FoodData Central",
                        sourceId: String(usdaFood.fdcId),
                    };
                } catch (err) {
                    console.error("Unable to load USDA food for editing:", err);
                }
            }
            // Keep the database grid consistent even when two foods contain
            // different nutrient profiles. The configured USDA nutrients come
            // first, followed by any additional nutrients already in the DB.
            const nutrientNames = [...new Set([
                ...Object.values(TRACKED_NUTRIENTS),
                ...foods.flatMap(food => Object.keys(food.foodNutrients)),
            ])];

            res.render("food-items", {
                foods,
                nutrientNames,
                appVersion: config.appVersion,
                initialFood,
            });
        });

        app.get("/food-search", async (req, res) => {
            const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
            let foods: any[] = [];
            let error = "";
            if (query) {
                try {
                    foods = (await UsdaFoodDataApi.searchFoods(query, { pageSize: 20 })).foods;
                } catch (err) {
                    error = err instanceof Error ? err.message : "Unable to search USDA foods.";
                }
            }
            res.render("food-search", { query, foods, error, appVersion: config.appVersion });
        });
    }
}

export default IndexController
