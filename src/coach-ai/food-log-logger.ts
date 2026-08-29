/**
 * Correlates the deliberately detailed console output for one food-log action.
 * Never include API keys or complete HTTP URLs here because those URLs contain
 * the USDA key as a query parameter.
 */
export class FoodLogLogger {
  private static nextRunNumber = 1;
  readonly runId = `${Date.now().toString(36)}-${FoodLogLogger.nextRunNumber++}`;

  constructor(private readonly username: string) {}

  info(message: string, details?: Record<string, unknown>) {
    this.write("INFO", message, details);
  }

  debug(message: string, details?: Record<string, unknown>) {
    this.write("DEBUG", message, details);
  }

  error(message: string, error?: unknown, details?: Record<string, unknown>) {
    const errorDetails = error instanceof Error
      ? { errorName: error.name, errorMessage: error.message, errorStack: error.stack }
      : { error };
    this.write("ERROR", message, { ...details, ...errorDetails }, true);
  }

  private write(
    level: "INFO" | "DEBUG" | "ERROR",
    message: string,
    details: Record<string, unknown> | undefined,
    isError = false,
  ) {
    const prefix = `[Food log ${this.runId}] ${level} user=${JSON.stringify(this.username)} ${message}`;
    if (isError) {
      console.error(prefix, details ?? {});
    } else {
      console.log(prefix, details ?? {});
    }
  }
}
