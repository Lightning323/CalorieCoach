import express from "express";
import { ObjectId } from "mongodb";
import { FoodDatabase, FoodNutrients, FoodPortion } from "../utils/food-database";

class FoodValidationError extends Error {}

class FoodController {
  register(app: express.Application) {
    app.post("/api/foods", async (req, res) => {
      try {
        const names = this.readFoodNames(req.body.names);
        const foodNutrients = this.readFoodNutrients(req.body.foodNutrients);
        const foodPortions = this.readFoodPortions(req.body.foodPortions);
        const source = this.readOptionalText(req.body.source);
        const sourceId = this.readOptionalText(req.body.sourceId);

        if (foodNutrients.calories === undefined) {
          return res.status(400).json({ message: "Calories are required." });
        }

        const food = await FoodDatabase.addFood({
          names,
          foodNutrients,
          foodPortions,
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
          names?: string[];
          foodNutrients?: FoodNutrients;
          foodPortions?: FoodPortion[];
          source?: string;
          sourceId?: string;
        } = {};

        if (req.body.names !== undefined) updates.names = this.readFoodNames(req.body.names);
        if (req.body.foodNutrients !== undefined) {
          updates.foodNutrients = this.readFoodNutrients(req.body.foodNutrients);
        }
        if (req.body.foodPortions !== undefined) {
          updates.foodPortions = this.readFoodPortions(req.body.foodPortions);
        }
        if (req.body.source !== undefined) updates.source = this.readOptionalText(req.body.source);
        if (req.body.sourceId !== undefined) updates.sourceId = this.readOptionalText(req.body.sourceId);

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

    app.delete("/api/foods", async (req, res) => {
      try {
        const requestedIds = req.body?.ids;
        if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
          return res.status(400).json({ message: "Select at least one food to delete." });
        }

        const ids = [...new Set(requestedIds)];
        if (!ids.every(id => typeof id === "string" && ObjectId.isValid(id))) {
          return res.status(400).json({ message: "One or more selected food IDs are invalid." });
        }

        await FoodDatabase.deleteFoods(ids);
        res.sendStatus(204);
      } catch (error) {
        console.error("Failed to delete foods:", error);
        res.status(500).json({ message: "Failed to delete selected foods" });
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

  private readFoodNutrients(value: unknown): FoodNutrients {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new FoodValidationError("Food nutrients are required.");
    }

    const foodNutrients: FoodNutrients = {};
    for (const [name, rawValue] of Object.entries(value)) {
      if (!this.isNutrientName(name)) {
        throw new FoodValidationError(`Invalid nutrient name: ${name}`);
      }
      if (rawValue === "" || rawValue === null || rawValue === undefined) continue;

      const number = Number(rawValue);
      if (!Number.isFinite(number)) {
        throw new FoodValidationError(`Nutrient ${name} must be a number.`);
      }
      foodNutrients[name] = number;
    }

    return foodNutrients;
  }

  private readFoodPortions(value: unknown): FoodPortion[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new FoodValidationError("At least one food portion is required.");
    }

    const foodPortions: FoodPortion[] = value.map((portion, index) => {
      if (!portion || typeof portion !== "object" || Array.isArray(portion)) {
        throw new FoodValidationError(`Food portion ${index + 1} is invalid.`);
      }

      const { unit, grams, rank } = portion as Record<string, unknown>;
      if (typeof unit !== "string" || !unit.trim() || unit.trim().length > 160) {
        throw new FoodValidationError(`Food portion ${index + 1} requires a unit.`);
      }

      const parsedGrams = Number(grams);
      if (!Number.isFinite(parsedGrams) || parsedGrams <= 0) {
        throw new FoodValidationError(`Food portion ${index + 1} requires positive grams.`);
      }

      const parsedRank = Number(rank);
      if (!Number.isInteger(parsedRank) || parsedRank <= 0) {
        throw new FoodValidationError(`Food portion ${index + 1} requires a positive whole-number rank.`);
      }

      const normalizedUnit = unit.trim().replace(/\s+/g, " ");
      const match = normalizedUnit.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
      return {
        ...(match ? { amount: Number(match[1]), measureUnit: { name: match[2] } } : { portionDescription: normalizedUnit }),
        gramWeight: parsedGrams,
        rank: parsedRank,
      };
    });

    return foodPortions.sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
  }

  private readOptionalText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new FoodValidationError("Food fields must be text.");
    return value.trim();
  }

  private readFoodNames(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
      throw new FoodValidationError("At least one food name is required.");
    }

    const names: string[] = [];
    const seenNames = new Set<string>();
    for (const suppliedName of value) {
      if (typeof suppliedName !== "string") {
        throw new FoodValidationError("Food names must be text.");
      }
      const name = suppliedName.trim().replace(/\s+/g, " ");
      if (!name || name.length > 160) {
        throw new FoodValidationError("Each food name must be between 1 and 160 characters.");
      }
      const normalizedName = name.toLowerCase();
      if (!seenNames.has(normalizedName)) {
        seenNames.add(normalizedName);
        names.push(name);
      }
    }

    if (names.length === 0) throw new FoodValidationError("At least one food name is required.");
    return names;
  }

  private isNutrientName(name: string): boolean {
    return name.length > 0 &&
      name.length <= 80 &&
      !name.startsWith("$") &&
      !name.includes(".") &&
      !["__proto__", "constructor", "prototype"].includes(name);
  }
}

export default FoodController;
