import express from "express";
import { FoodDatabase, FoodMetrics } from "../utils/food-database";

const LEGACY_METRIC_NAMES = ["calories", "protein", "carbs", "fat"] as const;

class FoodValidationError extends Error {}

class FoodController {
  register(app: express.Application) {
    app.post("/api/foods", async (req, res) => {
      try {
        const { name, quantity, calories, protein, carbs, fat } = req.body;
        const metrics = this.readMetrics(req.body.metrics, { calories, protein, carbs, fat });
        const source = this.readOptionalText(req.body.source);
        const sourceId = this.readOptionalText(req.body.sourceId);

        if (
          typeof name !== "string" ||
          !name.trim() ||
          typeof quantity !== "string" ||
          !quantity.trim() ||
          metrics.calories === undefined
        ) {
          return res.status(400).json({ message: "Invalid food data" });
        }

        const food = await FoodDatabase.addFood({
          name: name.trim(),
          quantity: quantity.trim(),
          metrics,
          ...(source ? { source } : {}),
          ...(sourceId ? { sourceId } : {}),
        });

        res.status(201).json({ _id: food._id });
      } catch (error) {
        console.error("Failed to add food:", error);
        if (error instanceof FoodValidationError) {
          return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Failed to add food" });
      }
    });

    app.put("/api/foods/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updates: {
          name?: string;
          quantity?: string;
          source?: string;
          sourceId?: string;
          metrics?: FoodMetrics;
        } = {};

        if (req.body.name !== undefined) {
          if (typeof req.body.name !== "string" || !req.body.name.trim()) {
            throw new FoodValidationError("Food name is required.");
          }
          updates.name = req.body.name.trim();
        }

        if (req.body.quantity !== undefined) {
          if (typeof req.body.quantity !== "string" || !req.body.quantity.trim()) {
            throw new FoodValidationError("Serving size is required.");
          }
          updates.quantity = req.body.quantity.trim();
        }

        if (req.body.source !== undefined) updates.source = this.readOptionalText(req.body.source);
        if (req.body.sourceId !== undefined) updates.sourceId = this.readOptionalText(req.body.sourceId);

        if (this.hasMetricPayload(req.body)) {
          // The editor sends the complete nutrition profile. Replacing it lets
          // users remove a nutrient by clearing its field instead of leaving
          // stale values behind.
          updates.metrics = this.readMetrics(req.body.metrics, req.body);
        }

        await FoodDatabase.updateFood(id, updates);
        res.sendStatus(204);
      } catch (error) {
        console.error("Failed to update food:", error);
        if (error instanceof FoodValidationError) {
          return res.status(400).json({ message: error.message });
        }
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
  ): FoodMetrics {
    const metrics: FoodMetrics = {};

    if (suppliedMetrics && typeof suppliedMetrics === "object" && !Array.isArray(suppliedMetrics)) {
      for (const [name, value] of Object.entries(suppliedMetrics)) {
        if (!this.isMetricName(name)) {
          throw new FoodValidationError(`Invalid nutrient name: ${name}`);
        }
        if (value === "" || value === null || value === undefined) continue;
        const number = Number(value);
        if (!Number.isFinite(number)) {
          throw new FoodValidationError(`Nutrient ${name} must be a number.`);
        }
        metrics[name] = number;
      }
    }

    for (const metric of LEGACY_METRIC_NAMES) {
      const value = legacyMetrics[metric];
      if (value === undefined || value === "") continue;

      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new FoodValidationError(`Nutrient ${metric} must be a number.`);
      }
      metrics[metric] = number;
    }

    return metrics;
  }

  private hasMetricPayload(body: Record<string, unknown>): boolean {
    return Object.prototype.hasOwnProperty.call(body, "metrics") ||
      LEGACY_METRIC_NAMES.some(metric => Object.prototype.hasOwnProperty.call(body, metric));
  }

  private readOptionalText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new FoodValidationError("Food fields must be text.");
    return value.trim();
  }

  private isMetricName(name: string): boolean {
    return name.length > 0 &&
      name.length <= 80 &&
      !name.startsWith("$") &&
      !name.includes(".") &&
      !["__proto__", "constructor", "prototype"].includes(name);
  }
}

export default FoodController;
