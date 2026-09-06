import express from "express";
import { addDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { ObjectId } from "mongodb";
import { connectDB } from "../db";
import { Accounts, FoodLog } from "../utils/account-database";
import { FoodDatabase } from "../utils/food-database";
import { FoodLoggerAPI } from "../coach-ai/food-log-service";
import { FoodLogProgress } from "../coach-ai/types";
import { config, TRACKED_NUTRIENTS, WELLNESS_NUTRIENT_GOALS } from "../config";
import { UsdaFoodDataApi } from "../api/usdaFoodDataApi";
import { foodPortionsFromUsda } from "../coach-ai/usda-food-resolver";
import { getUsdaFoodNutrientsPer100g } from "../api/usdaFoodDataApi";
import { scaleLoggedFoodNutrients } from "../utils/logged-food-nutrition";
import {
    dateFromFoodLogKey,
    foodLogDateKey,
    foodLogDateTimeFromLocalInput,
    getSafeTimeZone,
    isFoodLogDateKey,
} from "../utils/food-log-dates";

function shiftFoodLogDate(date: string, days: number): string {
    return formatInTimeZone(addDays(dateFromFoodLogKey(date), days), "UTC", "yyyy-MM-dd");
}

function formatFoodLogDate(date: string, today: string): string {
    if (date === today) return "Today";
    if (date === shiftFoodLogDate(today, -1)) return "Yesterday";
    return formatInTimeZone(dateFromFoodLogKey(date), "UTC", "EEEE, MMMM d, yyyy");
}

type ActiveFoodLog = FoodLogProgress & { date: string };

class IndexController {

    // Food logging continues on the server after a browser refresh. Keep the
    // latest update so a newly connected page can resume displaying it.
    private activeFoodLog: ActiveFoodLog | null = null;

    constructor(
        private readonly foodLoggerAPI = new FoodLoggerAPI()
    ){

    }

    register(io: any, app: express.Application) {
        io.on("connection", (socket: any) => {
            socket.on("get-food-log-status", () => {
                socket.emit("food-log-status", this.activeFoodLog
                    ? { active: true, ...this.activeFoodLog }
                    : { active: false });
            });

            socket.on("log-food", async (payload: { foodItems?: unknown; date?: unknown } = {}) => {
                const foodItems = typeof payload.foodItems === "string" ? payload.foodItems.trim() : "";

                if (!foodItems) {
                    socket.emit("food-log-error", { message: "Please enter at least one food item." });
                    return;
                }

                const account = await Accounts.getAccount(config.defaultUsername);
                if (!account) {
                    socket.emit("food-log-error", { message: "Account not found." });
                    return;
                }

                const timezone = getSafeTimeZone(account.timezone);
                const todayDate = foodLogDateKey(new Date(), timezone);
                const targetDate = typeof payload.date === "string" ? payload.date : "";
                if (!isFoodLogDateKey(targetDate) || targetDate > todayDate) {
                    socket.emit("food-log-error", {
                        message: "Food can only be logged for today or a previous day.",
                        date: targetDate,
                    });
                    return;
                }

                if (this.activeFoodLog) {
                    socket.emit("food-log-status", { active: true, ...this.activeFoodLog });
                    return;
                }

                // Acknowledge right away so the browser can remain usable while the AI works.
                this.activeFoodLog = { progress: 2, message: "Food log queued.", date: targetDate };
                socket.emit("food-log-queued", { date: targetDate });

                try {
                    const result = await this.foodLoggerAPI.logFood(
                        config.defaultUsername,
                        foodItems,
                        progress => {
                            this.activeFoodLog = { ...progress, date: targetDate };
                            io.emit("food-log-progress", { ...progress, date: targetDate });
                        },
                        targetDate,
                    );

                    if (result.success) {
                        // Broadcast only after persistence; pages append these entries without a reload.
                        io.emit("food-logged", { message: result.message, date: result.date, entries: result.entries });
                        this.activeFoodLog = null;
                    } else {
                        this.activeFoodLog = null;
                        io.emit("food-log-error", { message: result.message, date: targetDate });
                    }
                } catch (err) {
                    console.error("Unable to log food:", err);
                    this.activeFoodLog = null;
                    io.emit("food-log-error", { message: "Unable to log food. Please try again.", date: targetDate });
                }
            });
        });

        app.get("/", async (req, res) => {
            await connectDB(); // ensure DB is connected
            const account = await Accounts.getAccount(config.defaultUsername);
            if (!account) {
                return res.status(500).send("Account not found");
            }

            const timezone = getSafeTimeZone(account.timezone);
            const todayDate = foodLogDateKey(new Date(), timezone);
            const requestedDate = typeof req.query.date === "string" ? req.query.date : undefined;
            if (requestedDate !== undefined && (!isFoodLogDateKey(requestedDate) || requestedDate > todayDate)) {
                return res.status(400).send("The requested day must be a current or past YYYY-MM-DD date.");
            }
            const viewedDate = requestedDate ?? todayDate;
            const foodLogsByDate = Object.fromEntries(
                Object.entries(account.foodLogsByDate ?? {})
                    .filter(([date, logs]) => isFoodLogDateKey(date) && Array.isArray(logs)),
            ) as Record<string, FoodLog[]>;

            // Resolve every referenced food once, then use those hydrated logs
            // both for the selected day and the history summary.
            const allFoodLogs = Object.values(foodLogsByDate).flat();
            const foodsById = await FoodDatabase.getFoodsByIDs(allFoodLogs.map(food => food.foodItem_id));
            const hydrateFoodLog = (food: FoodLog) => {
                const foodItem = food.foodItem_id
                    ? foodsById.get(food.foodItem_id.toHexString()) ?? food.backup_foodItem
                    : food.backup_foodItem;
                return {
                    ...food,
                    foodItem,
                    nutrition: foodItem
                        ? scaleLoggedFoodNutrients(foodItem.foodNutrients, food.quantity, food.portion)
                        : {},
                };
            };
            const foodLogHistory = Object.fromEntries(
                Object.entries(foodLogsByDate).map(([date, logs]) => [date, logs.map(hydrateFoodLog)]),
            );
            const viewedFoods = [...(foodLogHistory[viewedDate] ?? [])].reverse();

            const proteinGoal = account.proteinGoal ?? 150;
            const message = req.query.bulletinMessage || "";

            res.render("index", {
                username: config.defaultUsername,
                appVersion: config.appVersion,
                viewedFoods,
                viewedDate,
                viewedDateLabel: formatFoodLogDate(viewedDate, todayDate),
                todayDate,
                previousDate: shiftFoodLogDate(viewedDate, -1),
                nextDate: viewedDate === todayDate ? null : shiftFoodLogDate(viewedDate, 1),
                isViewingToday: viewedDate === todayDate,
                foodLogHistory,
                calorieOffset: account.calorieOffset,
                maintenanceCalories: account.maintenanceCalories,
                proteinGoal,
                wellnessNutrientGoals: WELLNESS_NUTRIENT_GOALS,
                bulletinMessage: message,
            });
        });

        app.post("/delete-food", async (req, res) => {
            const { foodLogId, date } = req.body;
            if (!isFoodLogDateKey(date) || typeof foodLogId !== "string") {
                return res.status(400).json({ message: "Invalid food-log date or ID." });
            }
            await Accounts.deleteFoodLog(config.defaultUsername, date, foodLogId);
            res.redirect(`/?date=${encodeURIComponent(date)}`);
        });

        app.post("/add-database-food-log", async (req, res) => {
            const foodId = typeof req.body?.foodId === "string" ? req.body.foodId : "";
            if (!ObjectId.isValid(foodId)) return res.status(400).json({ message: "Invalid food ID." });

            const food = await FoodDatabase.getFoodByID(new ObjectId(foodId));
            if (!food) return res.status(404).json({ message: "Food not found." });
            const portion = [...food.foodPortions].sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0))[0];
            if (!portion) return res.status(400).json({ message: "Food has no available portion." });

            const foodLog = await Accounts.addFoodLog(config.defaultUsername, {
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
            const { foodLogId, date, loggedAt, quantity, portionAmount, portionGramWeight, portionUnit, notes } = req.body;
            if (!isFoodLogDateKey(date) || typeof foodLogId !== "string") {
              return res.status(400).send("Invalid food-log date or ID.");
            }

            const account = await Accounts.getAccount(config.defaultUsername);
            if (!account) return res.status(500).send("Account not found.");

            const timezone = getSafeTimeZone(account.timezone);
            const parsedLoggedAt = foodLogDateTimeFromLocalInput(loggedAt, timezone);
            if (!parsedLoggedAt) {
              return res.status(400).send("Choose a valid date and time for this food entry.");
            }
            const targetDate = foodLogDateKey(parsedLoggedAt, timezone);
            const todayDate = foodLogDateKey(new Date(), timezone);
            if (targetDate > todayDate) {
              return res.status(400).send("Food can only be logged for today or a previous day.");
            }

            const parsedPortionAmount = Number(portionAmount);
            const parsedPortionGramWeight = Number(portionGramWeight);
            const parsedPortionQuantity = Number(quantity);
            const normalizedPortionUnit = typeof portionUnit === "string" ? portionUnit.trim() : "";
            const hasSelectedPortion = Number.isFinite(parsedPortionAmount) && parsedPortionAmount > 0
              && Number.isFinite(parsedPortionGramWeight) && parsedPortionGramWeight > 0
              && Number.isFinite(parsedPortionQuantity) && parsedPortionQuantity > 0
              && normalizedPortionUnit.length > 0 && normalizedPortionUnit.length <= 160;
            await Accounts.editFoodLog(config.defaultUsername, date, foodLogId, {
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
              logDate: parsedLoggedAt,
              targetDate,
            });
            res.redirect(`/?date=${encodeURIComponent(targetDate)}`);
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
