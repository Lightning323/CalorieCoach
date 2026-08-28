import express from "express";
import { FoodDatabase } from "../utils/food-database";

class FoodController {
  register(app: express.Application) {
    app.post("/api/foods", async (req, res) => {
      try {
        const { name, quantity, calories, protein, carbs, fat } = req.body;
        const metrics = this.readMetrics(req.body.metrics, { calories, protein, carbs, fat });

        if (
          typeof name !== "string" ||
          !name.trim() ||
          metrics.calories === undefined
        ) {
          return res.status(400).json({ message: "Invalid food data" });
        }

        const food = await FoodDatabase.addFood({
          name: name.trim(),
          quantity,
          metrics,
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
        const metrics = this.readMetrics(req.body.metrics, req.body);
        const updates = {
          ...req.body,
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
        };
        delete updates.calories;
        delete updates.protein;
        delete updates.carbs;
        delete updates.fat;

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

  private readMetrics(
    suppliedMetrics: unknown,
    legacyMetrics: Record<string, unknown>,
  ): Record<string, number> {
    const metrics: Record<string, number> = {};

    if (suppliedMetrics && typeof suppliedMetrics === "object" && !Array.isArray(suppliedMetrics)) {
      for (const [name, value] of Object.entries(suppliedMetrics)) {
        const number = Number(value);
        if (Number.isFinite(number)) metrics[name] = number;
      }
    }

    for (const metric of ["calories", "protein", "carbs", "fat"]) {
      const value = legacyMetrics[metric];
      if (value === undefined || value === "") continue;

      const number = Number(value);
      if (Number.isFinite(number)) metrics[metric] = number;
    }

    return metrics;
  }
}

export default FoodController;
