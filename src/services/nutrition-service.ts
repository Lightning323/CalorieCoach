import { addDays, subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { Account, Accounts, DailyNutritionTotal, FoodLog } from "../utils/account-database";
import { FoodDatabase, FoodItem, FoodMetrics, getFoodMetric, getFoodMetrics, getFoodNames } from "../utils/food-database";

export interface NutritionTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface NutritionGoals {
  maintenanceCalories: number;
  calorieOffset: number;
  calorieTarget: number;
  proteinGoal: number;
}

export interface CurrentFoodLog {
  id: string | null;
  loggedAt: string | null;
  quantity: number;
  portion?: FoodLog["portion"];
  notes: string;
  food: {
    id: string | null;
    names: string[];
    servingSize: string;
    nutritionPerServing: FoodMetrics;
  } | null;
  nutrition: FoodMetrics;
}

export class AccountNotFoundError extends Error {
  constructor(username: string) {
    super(`Account \"${username}\" was not found.`);
    this.name = "AccountNotFoundError";
  }
}

const EMPTY_TOTALS: NutritionTotals = {
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function emptyTotals(): NutritionTotals {
  return { ...EMPTY_TOTALS };
}

function normalizeTotals(totals?: Partial<DailyNutritionTotal> | number): NutritionTotals {
  if (typeof totals === "number") {
    return { ...EMPTY_TOTALS, calories: totals };
  }

  return {
    calories: totals?.calories ?? 0,
    protein: totals?.protein ?? 0,
    carbs: totals?.carbs ?? 0,
    fat: totals?.fat ?? 0,
  };
}

function addTotals(target: NutritionTotals, source: NutritionTotals): NutritionTotals {
  return {
    calories: target.calories + source.calories,
    protein: target.protein + source.protein,
    carbs: target.carbs + source.carbs,
    fat: target.fat + source.fat,
  };
}

function toNutritionTotals(metrics: FoodMetrics): NutritionTotals {
  return {
    calories: metrics.calories ?? 0,
    protein: metrics.protein ?? 0,
    carbs: metrics.carbs ?? 0,
    fat: metrics.fat ?? 0,
  };
}

function getSafeTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";

  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

function toDateKey(date: Date, timeZone: string): string {
  return formatInTimeZone(date, timeZone, "yyyy-MM-dd");
}

function dateFromKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function multiplyFoodMetrics(food: FoodItem | null, quantity: number): FoodMetrics {
  if (!food) return {};

  return Object.fromEntries(
    Object.entries(getFoodMetrics(food)).map(([metric, value]) => [metric, value * quantity]),
  );
}

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;
  return toDateKey(dateFromKey(value), "UTC") === value;
}

export class NutritionService {
  async getCurrentFoods(username: string): Promise<{
    date: string;
    timezone: string;
    foods: CurrentFoodLog[];
    totals: NutritionTotals;
  }> {
    const account = await this.getAccount(username);
    const timeZone = getSafeTimeZone(account.timezone);
    const date = toDateKey(new Date(), timeZone);
    const foods = await this.getFoodsForDate(account, date, timeZone);

    return {
      date,
      timezone: timeZone,
      foods,
      totals: foods.reduce((total, food) => addTotals(total, toNutritionTotals(food.nutrition)), emptyTotals()),
    };
  }

  async getDailyNutrition(username: string, requestedDate?: string): Promise<{
    date: string;
    timezone: string;
    totals: NutritionTotals;
    goals: NutritionGoals;
  }> {
    const account = await this.getAccount(username);
    const timeZone = getSafeTimeZone(account.timezone);
    const date = requestedDate ?? toDateKey(new Date(), timeZone);
    const foods = await this.getFoodsForDate(account, date, timeZone);
    const totals = foods.length > 0
      ? foods.reduce((total, food) => addTotals(total, toNutritionTotals(food.nutrition)), emptyTotals())
      : normalizeTotals(account.foodHistory?.[date]);

    return { date, timezone: timeZone, totals, goals: this.getGoals(account) };
  }

  async getWeeklyNutrition(username: string, requestedEndDate?: string): Promise<{
    startDate: string;
    endDate: string;
    timezone: string;
    days: Array<{ date: string; totals: NutritionTotals }>;
    totals: NutritionTotals;
    goals: NutritionGoals;
  }> {
    const account = await this.getAccount(username);
    const timeZone = getSafeTimeZone(account.timezone);
    const endDate = requestedEndDate ?? toDateKey(new Date(), timeZone);
    const startDate = toDateKey(subDays(dateFromKey(endDate), 6), "UTC");
    const dates = Array.from(
      { length: 7 },
      (_, index) => toDateKey(addDays(dateFromKey(startDate), index), "UTC"),
    );
    const foodsByDate = await Promise.all(
      dates.map(async date => ({
        date,
        foods: await this.getFoodsForDate(account, date, timeZone),
      })),
    );
    const days = foodsByDate.map(({ date, foods }) => ({
      date,
      totals: foods.length > 0
        ? foods.reduce((total, food) => addTotals(total, toNutritionTotals(food.nutrition)), emptyTotals())
        : normalizeTotals(account.foodHistory?.[date]),
    }));

    return {
      startDate,
      endDate,
      timezone: timeZone,
      days,
      totals: days.reduce((total, day) => addTotals(total, day.totals), emptyTotals()),
      goals: this.getGoals(account),
    };
  }

  private async getAccount(username: string): Promise<Account> {
    const account = await Accounts.getAccount(username);
    if (!account) throw new AccountNotFoundError(username);
    return account;
  }

  private async getFoodsForDate(account: Account, date: string, timeZone: string): Promise<CurrentFoodLog[]> {
    const logs = (account.foods ?? [])
      .filter(log => log.logDate && toDateKey(log.logDate, timeZone) === date);
    const foods = await Promise.all(logs.map(log => this.toCurrentFoodLog(log)));

    return foods.sort((a, b) => {
      const left = a.loggedAt ? Date.parse(a.loggedAt) : 0;
      const right = b.loggedAt ? Date.parse(b.loggedAt) : 0;
      return right - left;
    });
  }

  private async toCurrentFoodLog(log: FoodLog): Promise<CurrentFoodLog> {
    const food = (await FoodDatabase.getFoodByID(log.foodItem_id)) ?? log.backup_foodItem ?? null;
    const quantity = Number.isFinite(log.quantity) ? log.quantity : 0;
    const nutrition = multiplyFoodMetrics(food, quantity);

    return {
      id: log._id?.toString() ?? null,
      loggedAt: log.logDate?.toISOString() ?? null,
      quantity,
      portion: log.portion,
      notes: log.notes ?? "",
      food: food
        ? {
          id: food._id?.toString() ?? log.foodItem_id?.toString() ?? null,
          names: getFoodNames(food),
          servingSize: food.quantity,
          nutritionPerServing: getFoodMetrics(food),
        }
        : null,
      nutrition,
    };
  }

  private getGoals(account: Account): NutritionGoals {
    const maintenanceCalories = account.maintenanceCalories ?? 0;
    const calorieOffset = account.calorieOffset ?? 0;

    return {
      maintenanceCalories,
      calorieOffset,
      calorieTarget: Math.max(100, maintenanceCalories + calorieOffset),
      proteinGoal: account.proteinGoal ?? 0,
    };
  }
}

export const Nutrition = new NutritionService();
