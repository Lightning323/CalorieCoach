import express from "express";
import { config } from "../config";
import { DEFAULT_USERNAME } from "../utils/constants";
import { AccountNotFoundError, isValidDateKey, Nutrition } from "../services/nutrition-service";

type DateQuery = string | undefined | null;

function readDateQuery(value: unknown): DateQuery {
  if (value === undefined) return undefined;
  return isValidDateKey(value) ? value : null;
}

class ApiController {
  register(app: express.Application) {
    const router = express.Router();

    router.use((req, res, next) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "X-API-Key");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

      if (req.method === "OPTIONS") {
        return res.sendStatus(204);
      }

      if (config.apiKey && req.get("X-API-Key") !== config.apiKey) {
        return res.status(401).json({ error: "A valid X-API-Key header is required." });
      }

      next();
    });

    router.get("/foods/current", async (_req, res) => {
      await this.sendData(res, () => Nutrition.getCurrentFoods(DEFAULT_USERNAME));
    });

    router.get("/nutrition/daily", async (req, res) => {
      const date = readDateQuery(req.query.date);
      if (date === null) return this.sendInvalidDate(res, "date");

      await this.sendData(res, () => Nutrition.getDailyNutrition(DEFAULT_USERNAME, date));
    });

    router.get("/nutrition/weekly", async (req, res) => {
      const endDate = readDateQuery(req.query.endDate);
      if (endDate === null) return this.sendInvalidDate(res, "endDate");

      await this.sendData(res, () => Nutrition.getWeeklyNutrition(DEFAULT_USERNAME, endDate));
    });

    app.use("/api/v1", router);
  }

  private sendInvalidDate(res: express.Response, parameter: string) {
    return res.status(400).json({
      error: `The ${parameter} parameter must be a calendar date in YYYY-MM-DD format.`,
    });
  }

  private async sendData(res: express.Response, getData: () => Promise<unknown>): Promise<void> {
    try {
      res.json({ data: await getData() });
    } catch (error) {
      if (error instanceof AccountNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }

      console.error("REST API request failed:", error);
      res.status(500).json({ error: "Unable to load nutrition data." });
    }
  }
}

export default ApiController;
