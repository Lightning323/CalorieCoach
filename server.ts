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

import { Accounts, FoodEntry } from "./accounts";
import { Foods } from "./food-database";
import { CoachAI } from "./coachAI";





app.get("/", async (req, res) => {
  await connectDB(); // ensure DB is connected

  const username = "Lightning323"; // use your default for now
  await Accounts.newAccount(username); // create account if missing

  const account = await Accounts.getAccount(username);
  if (!account) {
    return res.status(500).send("Account not found");
  }

  const todayFoods = await Accounts.getTodayFoods(username);
  const totalCalories = await Accounts.getTodayCalories(username);
  const calorieGoal = account.calorieGoal;

  res.render("index", {
    username,
    todayFoods,
    totalCalories,
    calorieGoal,
  });
});

/* ------------------ Log Food ------------------ */
app.post("/log-food", async (req, res) => {
  const username = "Lightning323"; // default
  const { name, quantity } = req.body;

  if (!name || !quantity) {
    return res.status(400).send("Missing required fields");
  }

  var result = await CoachAI.logFood(name, quantity);

  if(result.matchDescription) {
    console.log("FOOD \""+result.food.name+"\" (quantity: "+result.food.quantity+") MATCHED: " + result.matchDescription);
  } else if(result.calorieDescription) {
    console.log("FOOD \""+result.food.name+"\" (quantity: "+result.food.quantity+") ADDED: " + result.calorieDescription);
  }

  await Accounts.addFood(username, {
    name,
    quantity,
    calories: result.food.calories,
  });

  res.redirect("/");
});

app.post("/delete-food", async (req, res) => {
  const username = "Lightning323"; // default
  const { foodId } = req.body;

  if (!foodId) return res.status(400).send("Missing food ID");

  await Accounts.deleteFood(username, foodId);
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

import editDayFoodRouter from "./routes/edit-day-food";
app.use(editDayFoodRouter);



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

    const food = await Foods.addFood({
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

    await Foods.updateFood(id, updates);

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

    await Foods.deleteFood(id);

    res.sendStatus(204);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete food" });
  }
});
/* =========================
   Server Boot
========================= */

(async () => {
  await connectDB(); // 🔥 REQUIRED
  app.listen(3000, () =>
    console.log("🚀 Server running on http://localhost:3000")
  );
})();
