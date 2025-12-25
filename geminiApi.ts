import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function callGemini() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Explain how gluten affects digestion in simple terms.",
    });

    console.log("Gemini response:", response.text);
  } catch (err) {
    console.error("API error:", err);
  }
}

callGemini();

export { callGemini };