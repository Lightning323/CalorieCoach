import express from "express";
import { Accounts } from "../accounts";

const router = express.Router();

/* ------------------ Edit Food Entry for Today ------------------ */
router.post("/edit-day-food", async (req, res) => {
  const username = "Lightning323"; // default account
  const { foodId, name, quantity, calories } = req.body;

  if (!foodId || !name || !quantity || !calories) {
    return res.status(400).send("Missing required fields");
  }

  try {
    // Find all today's foods
    const todayFoods = await Accounts.getTodayFoods(username);

    // Find the food to edit
    const foodIndex = todayFoods.findIndex(f => f._id?.toString() === foodId);
    if (foodIndex === -1) return res.status(404).send("Food not found");

    const updatedFood = {
      ...todayFoods[foodIndex],
      name,
      quantity,
      calories: Number(calories),
    };

    // Remove old entry and push updated one
    const account = await Accounts.getAccount(username);
    if (!account) return res.status(500).send("Account not found");

    // Pull old food entry
    await Accounts.deleteFood(username, foodId);

    // Add updated food entry
    await Accounts.addFood(username, {
      name: updatedFood.name,
      quantity: updatedFood.quantity,
      calories: updatedFood.calories,
    });

    res.redirect("/"); // or send JSON if using AJAX
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

export default router;
