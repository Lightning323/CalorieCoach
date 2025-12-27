import express from "express";
import path from "path";
import { ObjectId } from "mongodb";
import { connectDB, getFoodCollection } from "./db";

const app = express();

/* =========================
   Middleware
========================= */

// Parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "middlewares/views"));

// Static assets
app.use(express.static(path.join(__dirname, "middlewares/public")));

/* =========================
   Page Routes
========================= */

import { Accounts, FoodLog, foodLogToString } from "./utils/account-database";
import { FoodDatabase } from "./utils/food-database";
import { CoachAI } from "./coachAI";
import { OpenFoodFactsApi } from "./api/openFoodFactsApi";

const username = "Lightning323"; // default


app.get("/", async (req, res) => {
  await connectDB(); // ensure DB is connected
  await Accounts.newAccount(username); // create account if missing

  const account = await Accounts.getAccount(username);
  if (!account) {
    return res.status(500).send("Account not found");
  }

  // Delete all food logs before today
  const deleted = await Accounts.deleteFoodsBeforeToday(username);
  if(deleted) console.log(`Deleted ${deleted} food logs before today`);
  //Get the food logs from the database
  const todayFoods2 = await Accounts.getAllFoods(username);

  //we need to get the actual food data from the food database and append it
  let todayFoods = await Promise.all(
    todayFoods2.map(async (f) => {
      var foodItem = await FoodDatabase.getFoodByID(f.foodItem_id);
      //if the food item is not found, use the backup
      if (!foodItem && f.backup_foodItem) {
        foodItem = f.backup_foodItem;
      }
      return { ...f, foodItem }; // add new property without mutating original
    })
  );
  todayFoods = todayFoods.reverse();

  const calorieGoal = account.calorieGoal;
  const message = req.query.bulletinMessage || "";

  res.render("index", {
    username,
    todayFoods,
    calorieGoal,
    bulletinMessage: message
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

/* ------------------ Update Calorie Goal ------------------ */
app.post("/calorie-goal", async (req, res) => {
  const username = "Lightning323"; // default
  const { calorieGoal } = req.body;

  if (!calorieGoal) return res.status(400).send("Missing calorie goal");

  await Accounts.setCalorieGoal(username, Number(calorieGoal));
  res.redirect("/");
});

app.get("/food-items", async (_req, res) => {
  const foods = await getFoodCollection().find().toArray();
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

    const food = await FoodDatabase.addFood({
      name,
      quantity,
      calories: Number(calories),
      protein: protein ? Number(protein) : undefined,
      carbs: carbs ? Number(carbs) : undefined,
      fat: fat ? Number(fat) : undefined,
    });

    res.status(201).json({ _id: food._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add food" });
  }
});

// Update food
app.put("/api/foods/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    await FoodDatabase.updateFood(id, updates);

    res.sendStatus(204);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update food" });
  }
});

// Delete food
app.delete("/api/foods/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await FoodDatabase.deleteFood(id);

    res.sendStatus(204);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete food" });
  }
});

/* =========================
   OpenFoodFacts API
========================= */
app.get("/foodFactsAPI", (req, res) => {
  res.render("foodFactsAPI", { results: null, query: "" });
});

// Handle search
app.post("/foodFactsAPI/search", async (req, res) => {
  const query = req.body.query;
  const results = await OpenFoodFactsApi.getAPIFoodMatches([query], 20);
  res.render("foodFactsAPI", { results: results[query], query });
});

/* =========================
   Server Boot
========================= */

(async () => {
  await connectDB(); // 🔥 REQUIRED
  app.listen(8080, () =>
    console.log("🚀 Server running on http://localhost:8080")
  );
})();
