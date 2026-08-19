import "dotenv/config";

export async function getNutritionData(query: string) {
  const apiKey = process.env.API_NINJAS_API_KEY;
  if (!apiKey) throw new Error("API_NINJAS_API_KEY must be set in .env");

  const encoded = encodeURIComponent(query);
  const url = `https://api.api-ninjas.com/v1/nutrition?query=${encoded}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "X-Api-Key": apiKey },
  });

  if (!response.ok) {
    throw new Error(`API Ninjas request failed with ${response.status} ${response.statusText}`);
  }

  return response.json();
}
