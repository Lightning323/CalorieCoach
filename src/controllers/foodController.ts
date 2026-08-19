import express from "express";
import { FoodDatabase } from "../utils/food-database";

class FoodController {
  register(app: express.Application) {
    app.post("/api/foods", async (req, res) => {
      try {
        const { name, quantity, calories, protein, carbs, fat } = req.body;

        if (
          typeof name !== "string" ||
          !name.trim() ||
          calories === undefined ||
          calories === "" ||
          !Number.isFinite(Number(calories))
        ) {
          return res.status(400).json({ message: "Invalid food data" });
        }

        const food = await FoodDatabase.addFood({
          name: name.trim(),
          quantity,
          calories: Number(calories),
          protein: protein ? Number(protein) : undefined,
          carbs: carbs ? Number(carbs) : undefined,
          fat: fat ? Number(fat) : undefined,
        });

        res.status(201).json({ _id: food._id });
      } catch (error) {
        console.error("Failed to add food:", error);
        res.status(500).json({ message: "Failed to add food" });
      }
    });

    app.put("/api/foods/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updates = {
          ...req.body,
          calories: req.body.calories !== undefined ? Number(req.body.calories) : undefined,
          protein: this.toOptionalNumber(req.body.protein),
          carbs: this.toOptionalNumber(req.body.carbs),
          fat: this.toOptionalNumber(req.body.fat),
        };

        await FoodDatabase.updateFood(id, updates);
        res.sendStatus(204);
      } catch (error) {
        console.error("Failed to update food:", error);
        res.status(500).json({ message: "Failed to update food" });
      }
    });

    app.delete("/api/foods/:id", async (req, res) => {
      try {
        await FoodDatabase.deleteFood(req.params.id);
        res.sendStatus(204);
      } catch (error) {
        console.error("Failed to delete food:", error);
        res.status(500).json({ message: "Failed to delete food" });
      }
    });
  }

  private toOptionalNumber(value: unknown): number | undefined {
    return value === undefined || value === "" ? undefined : Number(value);
  }
}

export default FoodController;
