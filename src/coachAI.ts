// Compatibility entry point: the food-log workflow lives in focused modules
// under coach-ai/ so parser, local resolution, USDA resolution, and logging
// can be found independently.
export { CoachAI, CoachAIService } from "./coach-ai/food-log-service";
export type {
  FoodLogProgress,
  FoodLogResult,
  LoggedFoodEntry,
} from "./coach-ai/types";
