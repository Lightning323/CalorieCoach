"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
const app = (0, express_1.default)();
/* =========================
   Middleware
========================= */
// Parse JSON bodies
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// View engine
app.set("view engine", "ejs");
app.set("views", path_1.default.join(__dirname, "middlewares/views"));
// Static assets
app.use(express_1.default.static(path_1.default.join(__dirname, "middlewares/public")));
/* =========================
   Page Routes
========================= */
const account_database_1 = require("./utils/account-database");
const food_database_1 = require("./utils/food-database");
const coachAI_1 = require("./coachAI");
const username = "Lightning323"; // default
app.get("/", async (req, res) => {
    await (0, db_1.connectDB)(); // ensure DB is connected
    await account_database_1.Accounts.newAccount(username); // create account if missing
    const account = await account_database_1.Accounts.getAccount(username);
    if (!account) {
        return res.status(500).send("Account not found");
    }
    // Delete all food logs before today
    await account_database_1.Accounts.deleteFoodsBeforeToday(username);
    //Get the food logs from the database
    const todayFoods2 = await account_database_1.Accounts.getTodayFoods(username);
    //we need to get the actual food data from the food database and append it
    const todayFoods = await Promise.all(todayFoods2.map(async (f) => {
        var foodDatabase = new food_database_1.FoodDatabase();
        var foodItem = await foodDatabase.getFoodByID(f.foodItem_id?.toString());
        //if the food item is not found, use the backup
        if (!foodItem && f.backup_foodItem) {
            foodItem = f.backup_foodItem;
        }
        return { ...f, foodItem }; // add new property without mutating original
    }));
    const calorieGoal = account.calorieGoal;
    res.render("index", {
        username,
        todayFoods,
        calorieGoal,
    });
});
/* ------------------ Log Food ------------------ */
app.post("/log-food", async (req, res) => {
    const { foodItems } = req.body;
    var results = await coachAI_1.CoachAI.logFood(username, foodItems);
    res.redirect("/");
});
app.post("/delete-food", async (req, res) => {
    const { foodLogId } = req.body;
    await account_database_1.Accounts.deleteFoodLog(username, foodLogId);
    res.redirect("/");
});
app.post("/edit-day-food", async (req, res) => {
    const { foodLogId, quantity, notes } = req.body;
    await account_database_1.Accounts.editFoodLog(username, foodLogId, {
        quantity: Number(quantity),
        notes,
    });
    res.redirect("/");
});
/* ------------------ Update Calorie Goal ------------------ */
app.post("/calorie-goal", async (req, res) => {
    const username = "Lightning323"; // default
    const { calorieGoal } = req.body;
    if (!calorieGoal)
        return res.status(400).send("Missing calorie goal");
    await account_database_1.Accounts.setCalorieGoal(username, Number(calorieGoal));
    res.redirect("/");
});
app.get("/food-items", async (_req, res) => {
    const foods = await (0, db_1.getFoodCollection)().find().toArray();
    res.render("food-items", { foods });
});
/* =========================
   Food database POST requests
========================= */
// Create food
app.post("/api/foods", async (req, res) => {
    try {
        const { name, quantity, calories, protein, carbs, fat } = req.body;
        if (!name || !calories) {
            return res.status(400).json({ message: "Invalid food data" });
        }
        const food = await food_database_1.Foods.addFood({
            name,
            quantity,
            calories: Number(calories),
            protein: protein ? Number(protein) : undefined,
            carbs: carbs ? Number(carbs) : undefined,
            fat: fat ? Number(fat) : undefined,
        });
        res.status(201).json({ _id: food._id });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to add food" });
    }
});
// Update food
app.put("/api/foods/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        await food_database_1.Foods.updateFood(id, updates);
        res.sendStatus(204);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to update food" });
    }
});
// Delete food
app.delete("/api/foods/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await food_database_1.Foods.deleteFood(id);
        res.sendStatus(204);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to delete food" });
    }
});
/* =========================
   Server Boot
========================= */
(async () => {
    await (0, db_1.connectDB)(); // 🔥 REQUIRED
    app.listen(8080, () => console.log("🚀 Server running on http://localhost:8008"));
})();
