import express from "express";
import path from "path";
import { ObjectId } from "mongodb";
import { connectDB, getFoodCollection } from "./db";
import { Accounts, FoodLog, foodLogToString } from "./utils/account-database";
import { FoodDatabase } from "./utils/food-database";
import { CoachAI } from "./coachAI";
import { OpenFoodFactsApi } from "./api/openFoodFactsApi";
const constants = require("./utils/constants");
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const username = "Lightning323"; // default
const PORT = 8080;
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
import IndexController from './controllers/indexController';
new IndexController().register(app);


//Retrieve the user's timezone from the client
app.post('/timezone', (req, res) => {
  const { timezone } = req.body;

  console.log('User timezone:', timezone);
  Accounts.setTimezone(username, timezone);

  //response
  res.json({
    message: 'Timezone received!',
    timezone
  });
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
    const updates = {
      ...req.body,
      calories: req.body.calories !== undefined ? Number(req.body.calories) : undefined,
      protein: req.body.protein !== undefined && req.body.protein !== "" ? Number(req.body.protein) : undefined,
      carbs: req.body.carbs !== undefined && req.body.carbs !== "" ? Number(req.body.carbs) : undefined,
      fat: req.body.fat !== undefined && req.body.fat !== "" ? Number(req.body.fat) : undefined,
    };

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
  res.render("foodFactsAPI", {
    appVersion: constants.getAppVersion(),
    results: null, query: "",
  });
});

// Handle search
app.post("/foodFactsAPI/search", async (req, res) => {
  const query = req.body.query;
  const results = await OpenFoodFactsApi.getAPIFoodMatches([query], 20);
  res.render("foodFactsAPI", {
    results: results[query], query,
    appVersion: constants.getAppVersion(),
  });
});

/* =========================
   Server Boot
========================= */

(async () => {
  await connectDB(); // 🔥 REQUIRED
  app.listen(PORT, () =>
    console.log("🚀 Server running on port "+PORT)
  );
})();

/* =========================
   Websocket
========================= */
const server = http.createServer(app); // Create an HTTP server instance
const io = new Server(server);         // Attach Socket.io to that server

// Socket.io connection handler
io.on('connection', (socket: any) => {
    console.log('A user connected:', socket.id);
  
    // socket.on('reload', (msg: any) => {
    //     io.emit('reload');
    // });
    socket.on('disconnect', () => console.log('User disconnected'));
});

// Start the server (MUST use the 'server' object, not 'app')
server.listen(PORT, () => console.log('Socket.io Server running on port '+PORT));
