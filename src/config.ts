import "dotenv/config";

function getPort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8080;
}

export const config = {
  port: getPort(process.env.PORT),
  /** Optional protection for the public read API. */
  apiKey: process.env.CALORIE_COACH_API_KEY,
};
