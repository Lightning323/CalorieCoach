import "dotenv/config";
if (!process.env.API_NINJAS_API_KEY) throw new Error("API_NINJAS_API_KEY must be set in .env");

export async function getNutritionData(query: string) {
    const encoded = encodeURIComponent(query);
    const url = `https://api.api-ninjas.com/v1/nutrition?query=${encoded}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "X-Api-Key": process.env.API_NINJAS_API_KEY as string,
        },
    });
    const data = await response.json();
    return data;
}

async function main() {
console.log(await getNutritionData("apple"));
}

main();